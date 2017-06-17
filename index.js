'use strict'

const request = require('superagent')
const Koa = require('koa')
const bodyparser = require('koa-bodyparser')
const route = require('koa-route')
const { URL } = require('url')
const crypto = require('crypto')
// TODO use a better db
const lowdb = require('lowdb')

const SEND_REGEX = /^<@([a-z0-9]+)\|([a-z0-9]+)> (\d+\.?\d*) (.*)?$/i
const REGISTER_REGEX = /^<(.*)\/register\/(.*)>$/
const SPSP_FIELD_REGEX = /spsp address/gi
const USER_INFO_URL = 'https://slack.com/api/users.profile.get'
const POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage'
const TEAM_INFO_URL = 'https://slack.com/api/team.info'

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
      console.log('Error: status=' + err.statusCode, err.error)
    } else {
      console.log(err)
    }
    err.expose = true
    throw err
  }
})
// TODO store passwords in a better way
app.context.db = lowdb(process.env.DB_URL || './db.json')
app.use(verify(slackVerificationToken))
app.use(route.post('/send', sendHandler))
app.use(route.post('/register', registerHandler))

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

async function sendHandler (ctx, next) {
  const body = ctx.request.body

  const credentials = ctx.db.get(body.user_id).value()
  if (!credentials) {
    return request.post(body.response_url)
      .send({
        text: 'Sorry, you need to register first before you can send payments!'
      })
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
    return ctx.throw(400, err.message, { expose: true })
  }

  let spspAddress
  try {
    const user = await getUserInfo(params.id)
    for (let field of Object.keys(user.profile.fields)) {
      if (user.profile.fields[field].label.match(SPSP_FIELD_REGEX)) {
        spspAddress = user.profile.fields[field].value
      }
    }
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
    return ctx.throw(422, `uh oh! it looks like @${params.name} doesn't have their SPSP Address sent in their profile`, { expose: true })
  }

  ctx.status = 200
  ctx.body = {
    response_type: 'ephemeral',
    text: 'Sending payment...'
  }
  await next()

  let paymentResult
  try {
    paymentResult = await sendPayment({
      spspAddress,
      amount: params.amount,
      message: params.message,
      credentials
    })
  } catch (err) {
    return sendError(body.response_url, err.message)
  }

  // TODO post in the channel for successful payments
  const result = await request.post(body.response_url)
    .send({
      text: `Sent! (source amount: ${paymentResult.sourceAmount}) :money_with_wings:`
    })
}

async function registerHandler (ctx, next) {
  const body = ctx.request.body
  console.log('register got body', body)

  // TODO don't re-register if they already have an account with us

  let ilpKitHost
  let inviteCode
  try {
    const match = REGISTER_REGEX.exec(body.text)
    ilpKitHost = match[1]
    inviteCode = match[2]

  } catch (err) {
    console.log('got invalid registration request', body)
    return ctx.throw(422, 'registration request must include ILP Kit invite code URL', { expose: true })
  }

  // Respond to the user before we actually try creating the account because it might take too long
  ctx.status = 200
  ctx.body = {
    response_type: 'ephemeral',
    text: 'Registering...'
  }
  await next()

  // Determine the account credentials
  const username = ('payto-' + body.user_name + '-' + crypto.randomBytes(4).toString('hex')).slice(0,21)
  const password = crypto.randomBytes(12).toString('base64')

  // Get their email
  let email
  let fullName
  try {
    const user = await getUserInfo(body.user_id)
    const userEmail = user.profile.email || 'blah@example.com'
    email = userEmail.replace('@', '+' + username + '@')
    fullName = user.profile.first_name + ' ' + user.profile.last_name
  } catch (err) {
    return sendError(body.response_url, 'Error: could not get your email address from your Slack profile')
  }

  // Try registering the account
  let balance
  let accountUrl
  try {
    accountUrl = (new URL(`/api/users/${username}`, ilpKitHost)).toString()
    console.log(`attempting to register account: ${accountUrl} with invite code: ${inviteCode} email: ${email}`)
    const registerResult = await request.post(accountUrl)
      .send({
        password,
        inviteCode,
        email,
        name: fullName
      })
    balance = registerResult.body.balance
    // TODO add profile picture from slack?
  } catch (err) {
    console.log(`error registering user ${username} on ilp kit ${ilpKitHost}`, err.statusCode, err.body || err)
    return sendError(body.response_url, `Error registering user ${username} on ${ilpKitHost}: ${err.body && err.body.message || err.message}`)
  }

  ctx.db.set(body.user_id, {
    ilpKitHost,
    username,
    password
  })
  .write()

  console.log(`created account ${accountUrl}, balance is ${balance}`)

  try {
    return request.post(body.response_url)
      .send({
        text: `Registered user ${username} on ${ilpKitHost} with invite code, balance is ${balance}`
        // TODO include SPSP address to pay to fund account more
      })
  } catch (err) {
    console.log(err)
  }
}

async function sendError (url, text) {
  return request.post(url)
    .send({
      response_type: 'ephemeral',
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
    throw new Error('Oh no, I couldn\'t get a quote! :zipper_mouth_face:')
  }

  // TODO confirm quote with user

  const paymentUrl = (new URL('/api/payments/' + quote.id, credentials.ilpKitHost)).toString()
  try {
    await request.put(paymentUrl)
      .auth(credentials.username, credentials.password)
      .send({
        quote,
        message
      })

  } catch (err) {
    console.log('error sending payment', err.status, err.response && err.response.body || err)
    throw new Error('Eek, I tried, I tried, but the payment just wouldn\'t go through! :cold_sweat:')
  }

  return {
    sourceAmount: quote.sourceAmount
  }

}

async function sendSignupMessage ({ toUserId, toUsername, fromUserId, fromUsername }) {
  try {
    const teamInfoResult = await request.post(TEAM_INFO_URL)
      .type('form')
      .send({
        token: slackToken
      })
    const teamName = teamInfoResult.body.team.name
    const teamDomain = teamInfoResult.body.team.domain

    await request.post(POST_MESSAGE_URL)
      .type('form')
      .send({
        token: slackToken,
        channel: '@' + toUsername,
        as_user: false,
        username: 'Payto (Philosopher Banker and ILP/SPSP Slackbot)',
        text: `Citizen <@${toUserId}|${toUsername}>,

Your fellow citizen, <@${fromUserId}|${fromUsername}>, has attempted to send you money but you have failed to include your <https://${teamDomain}.slack.com/team/${toUsername}|SPSP Address in your Slack Profile>.

If you your SPSP Address to your profile, other members of the Republic of ${teamName} will be able to reward you for your courageous deeds by typing \`/payto\` in Slack! :money_with_wings:

You can also call upon my knowledge of the Interledger paths wtih \`/payto-register\`.


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
    'The first and best victory is to conquer SWIFT.',
    'The penalty good developers pay for indifference to payment efficiency is to be ruled by uncompetitive networks.',
    'Man is a being in search of the Internet of Value.',
    'The measure of a man is what he does with Interledger.',
    'The greatest wealth is to live streaming content with little Interledger payments.'
  ]
  return quotes[Math.floor(Math.random() * quotes.length)]
}

console.log('listening on port: ' + port)
app.listen(port)
