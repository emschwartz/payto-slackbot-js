'use strict'

const request = require('superagent')
const Koa = require('koa')
const bodyparser = require('koa-bodyparser')
const route = require('koa-route')
const { URL } = require('url')
const crypto = require('crypto')
const redis = require('redis')
const util = require('util')

const SEND_REGEX = /^<@([a-z0-9]+)\|([a-z0-9]+)> (\d+\.?\d*) ?(.*)?$/i
const REGISTER_REGEX = /register (\S+)@(\S+) (.+)$/i
const REGISTER_ESCAPED_REGEX = /register .*<mailto:.*\|(\S+?)@(\S+?)\> (.+)$/
const INFO_REGEX = /info/i
const SPSP_FIELD_REGEX = /spsp address/gi
const USER_INFO_URL = 'https://slack.com/api/users.profile.get'
const USER_PROFILE_SET_URL = 'https://slack.com/api/users.profile.set'
const POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage'
const TEAM_PROFILE_URL = 'https://slack.com/api/team.profile.get'

const slackToken = process.env.SLACK_TOKEN
const slackVerificationToken = process.env.SLACK_VERIFICATION_TOKEN
const port = process.env.PORT || 3000

const app = new Koa()
app.use(bodyparser())
app.use(async function errorHandler (ctx, next) {
  try {
    await next()
  } catch (err) {
    if (err.statusCode && err.statusCode >= 300) {
      console.log('Error: status=' + err.statusCode, err.error || err.body || err.response && err.response.body || err)
    } else {
      console.log(err)
    }
    err.expose = true
    throw err
  }
})
app.context.db = redis.createClient(process.env.REDIS_URL)
app.context.db.on('error', (err) => console.log('redis error', err))
app.use(route.get('/', async function (ctx, next) {
  ctx.body = 'Hello, this is the Payto Slackbot server'
}))
app.use(verify(slackVerificationToken))
app.use(route.post('/', requestHandler))

;(async function main () {
  const teamProfileResponse = await request.post(TEAM_PROFILE_URL)
    .type('form')
    .send({
      token: slackToken
    })
  const fields = teamProfileResponse.body.profile.fields
  for (let field of fields) {
    if (field.label.match(SPSP_FIELD_REGEX)) {
      app.context.spspField = field.id
    }
  }
  if (!app.context.spspField) {
    throw new Error('Could not find SPSP Address field in team profile')
  }

  console.log('listening on port: ' + port)
  app.listen(port)
})().catch(err => console.log(err))


function verify (token) {
  return async function verify (ctx, next) {
    const body = ctx.request.body
    if (body.token !== token) {
      console.log('got invalid request: ', body)
      const err = new Error('invalid token')
      return ctx.throw(403, 'invalid verification token', { expose: true })
    }
    return next()
  }
}

async function requestHandler (ctx, next) {
  const body = ctx.request.body

  if (SEND_REGEX.test(body.text)) {
    await sendHandler(ctx, next)
  } else if (REGISTER_ESCAPED_REGEX.test(body.text)) {
    // TODO just use a regex that can handle escaped and unescaped SPSP addresses
    const match = REGISTER_ESCAPED_REGEX.exec(body.text)
    const username = match[1]
    const host = match[2]
    const password = match [3]
    ctx.request.body.text = `register ${username}@${host} ${password}`
    await registerHandler(ctx, next)
  } else if (REGISTER_REGEX.test(body.text)) {
    await registerHandler(ctx, next)
  } else if (INFO_REGEX.test(body.text)) {
    await infoHandler(ctx, next)
  } else {
    await sendHelpMessage (ctx, next)
  }
}

async function sendHelpMessage (ctx, next) {
  ctx.body = {
    text: `Available commands:

    - \`/payto register user@ilp-kit.example password\` - Register ILP Kit account to send payments
    - \`/payto @user amount [optional message]\`        - Send an ILP payment
    - \`/payto info\`                                   - Get your balance and SPSP Address
`
  }
}

async function infoHandler (ctx, next) {
  const body = ctx.request.body

  const credentials = await util.promisify(ctx.db.hgetall).bind(ctx.db)(body.user_id)
  if (!credentials) {
    ctx.body = {
      text: 'You need to register an ILP kit account first!'
    }
    return
  }

  const spspAddress = credentials.username + '@' + (new URL(credentials.ilpKitHost)).host

  let currency
  let balance
  try {
    const userInfoRes = await request.get((new URL(`/api/users/${credentials.username}`, credentials.ilpKitHost)).toString())
      .auth(credentials.username, credentials.password)
    console.log(userInfoRes.response)
    balance = userInfoRes.body.balance

    const configRes = await request.get((new URL('/api/config' , credentials.ilpKitHost)).toString())
      .auth(credentials.username, credentials.password)

    // TODO change how this works when ilp-kits support multiple currencies
    currency = configRes.body.currencySymbol || configRes.body.currencyCode
  } catch (err) {
    console.log('error getting currency and balance', err)
  }
  if (!currency) {
   currency = '(Unable to determine currency)'
  }
  if (!balance) {
    balance = '(Unable to determine balance)'
  }

  ctx.body = {
    text: `Account Info:
> SPSP Address: \`${spspAddress}\`
> Balance: \`${currency} ${balance}\`

You can add more money by sending to your SPSP Address from any other ILP/SPSP wallet.`
  }
}

async function sendHandler (ctx, next) {
  const body = ctx.request.body

  const credentials = await util.promisify(ctx.db.hgetall).bind(ctx.db)(body.user_id)
  if (!credentials) {
    ctx.body = {
      text: 'You need to register an ILP kit account before you can send payments!'
    }
    return
  }

  let params
  try {
    const match = SEND_REGEX.exec(body.text)
    if (!match) {
      throw new Error('parameters must be in the form "@user amount [message]"')
    }
    params = {
      id: match[1],
      name: match[2],
      amount: match[3],
      message: match[4]
    }
    console.log(`got request from @${body.user_name} to send payment with params:`, params)
  } catch (err) {
    ctx.body = {
      text: err.message
    }
    ctx.status = 400
    return
  }

  let spspAddress
  try {
    const user = await getUserInfo(params.id)
    spspAddress = user.profile.fields[ctx.spspField].value
    if (!spspAddress) {
      throw new Error('could not find SPSP Address field in profile')
    }
  } catch (err) {
    await sendSignupMessage({
      toUserId: params.id,
      toUsername: params.name,
      fromUserId: body.user_id,
      fromUsername: body.user_name
    })
    ctx.body = {
      text: `Uh oh! <@${params.id}|${params.name}> doesn't have their SPSP Address in their Slack Profile.

I've sent them a message to suggest they add it, but you might want to give them a little nudge as well!`
    }
    return
  }

  ctx.body = {
    text: `Paying ${params.amount} to @${params.name} (${spspAddress})...`
  }
  await next()

  sendPayment({
    spspAddress,
    amount: params.amount,
    message: params.message,
    credentials
  }).then(({ sourceAmount, sourceAddress }) => {
    // TODO add a button to hide the extra details
    const text = `<@${body.user_id}|${body.user_name}> sent an ILP payment to <@${params.id}|${params.name}> :money_with_wings:

> Sender \`${sourceAddress}\` sent \`${sourceAmount}\`
> Receiver \`${spspAddress}\` received \`${params.amount}\``
    return request.post(body.response_url)
      .send({
        response_type: 'in_channel',
        text
      })
  }).then(() => {
    // TODO add button to send thank you back to sender
    let text = `You just got paid ${params.amount} by @${body.user_name}!`
    if (params.message) {
      text += ` They said:
> ${params.message.replace('\n', '\n> ')}`
    }
    return request.post(POST_MESSAGE_URL)
      .type('form')
      .send({
        token: slackToken,
        channel: '@' + params.name,
        as_user: false,
        username: 'Payto (Philosopher Banker and ILP/SPSP Slackbot)',
        text
      })
  }).catch(sendError.bind(null, body.response_url))
}

async function registerHandler (ctx, next) {
  const body = ctx.request.body

  let username
  let password
  let ilpKitHost
  let spspAddress
  try {
    const match = REGISTER_REGEX.exec(body.text)
    username = match[1]
    ilpKitHost = 'https://' + match[2]
    password = match[3]
    spspAddress = match[1] + '@' + match[2]
  } catch (err) {
    console.log('got invalid registration request', body)
    ctx.body = {
      text: 'You need to give your SPSP Address and password to register'
    }
    ctx.status = 400
    return
  }

  await util.promisify(ctx.db.hmset).bind(ctx.db)(body.user_id, {
    ilpKitHost,
    username,
    password
  })

  try {
    const setProfileRes = await request.post(USER_PROFILE_SET_URL)
      .type('form')
      .send({
        token: slackToken,
        user: body.user_id,
        name: ctx.spspField,
        value: spspAddress
      })
    if (!setProfileRes.body.ok) {
      throw new Error(setProfileRes.body.error)
    }
  } catch (err) {
    console.log(`error setting SPSP Address field in user profile: ${body.user_id}`, err)
    ctx.body = {
      text: `Registered :ok_hand:

Now just set your SPSP Address in your Slack Profile!

You can send payments by typing:
\`/payto @user amount [optional message]\``
    }
    return
  }

  ctx.body = {
    text: `Registered :ok_hand:

You can send payments by typing:
\`/payto @user amount [optional message]\``
  }
}

async function sendError (url, err) {
  console.log('got error', err)
  const text = typeof err === 'string'
    ? err
    : err.message
  return request.post(url)
    .send({
      text: text
    })
}

async function getUserInfo (id) {
  try {
    const result = await request.post(USER_INFO_URL)
      .type('form')
      .send({
        token: slackToken,
        user: id,
        include_labels: true
      })
    return result.body
  } catch (err) {
    console.log('error getting user info', err)
    throw new Error('error getting user info: ' + err.status + ' ' + err.message)
  }
}

async function sendPayment ({ spspAddress, amount, message, credentials }) {
  console.log(`send SPSP payment for ${amount} to ${spspAddress} with message: "${message}" from ${credentials.username} on ${credentials.ilpKitHost}`)

  const quoteUrl = (new URL('/api/payments/quote', credentials.ilpKitHost)).toString()
  let quote
  try {
    const quoteResult = await request.post(quoteUrl)
      .auth(credentials.username, credentials.password)
      .send({
        destination: spspAddress,
        destinationAmount: amount
      })
    quote = quoteResult.body
    console.log('got quote:', quote.sourceAmount)
  } catch (err) {
    console.log('error getting quote', err.status, err.response && err.response.body || err)
    throw new Error('Eek! No quote found... :zipper_mouth_face:')
  }
  // TODO confirm quote with user

  // Get destination details
  const detailsUrl = (new URL('/api/parse/destination?destination=' + encodeURI(spspAddress), credentials.ilpKitHost)).toString()
  let destinationDetails
  try {
    const detailsResult = await request.get(detailsUrl)
      .auth(credentials.username, credentials.password)
    destinationDetails = detailsResult.body
  } catch (err) {
    console.log('error getting destination details', err.status, err.response && err.response.body || err)
    throw new Error('Hmm, I couldn\'t get the details for that user\'s SPSP Address... :confused:')
  }

  const paymentUrl = (new URL('/api/payments/' + quote.id, credentials.ilpKitHost)).toString()
  try {
    await request.put(paymentUrl)
      .auth(credentials.username, credentials.password)
      .send({
        quote,
        message,
        destination: destinationDetails
      })
  } catch (err) {
    console.log('error sending payment', err.status, err.response && err.response.body || err)
    throw new Error('Something went wrong while sending the payment :cold_sweat:')
  }

  return {
    sourceAmount: quote.sourceAmount,
    sourceAddress: credentials.username + '@' + (new URL(credentials.ilpKitHost)).host
  }

}

async function sendSignupMessage ({ toUserId, toUsername, fromUserId, fromUsername }) {
  try {
    await request.post(POST_MESSAGE_URL)
      .type('form')
      .send({
        token: slackToken,
        channel: '@' + toUsername,
        as_user: false,
        username: 'Payto (Philosopher Banker and ILP/SPSP Slackbot)',
        text: `My good <@${toUserId}|${toUsername}>,

Socrates tells me that <@${fromUserId}|${fromUsername}> just tried to send you money via Interledger. However, you have not inscribed your SPSP Address in your Slack Profile!

You can register by typing:
\`/payto register ${toUserId}@your-ilp-kit.example your-password\`

Then you can send payments (and your teammates can pay you) with:
\`/payto <@${toUserId}|${toUsername}> 10 Here's some money!\`!


> _${getPaytoQuote()}_
> - Payto`
      })
    console.log(`sent signup message to @${toUsername}`)
  } catch (err) {
    console.log(`error sending signup message to @${toUsername}`, err)
  }
}

function getPaytoQuote () {
  const quotes = [
    'We can easily forgive a banker who is afraid of Interledger; the real tragedy of life is when developers are afraid of the IoV.',
    'Interledger payments are their own reward.',
    'The penalty good developers pay for indifference to payment efficiency is to be ruled by uncompetitive networks.',
    'Man is a being in search of the Internet of Value.',
    'The measure of a man is what he does with Interledger.',
    'The greatest wealth is to live streaming content with little Interledger payments.'
  ]
  return quotes[Math.floor(Math.random() * quotes.length)]
}

