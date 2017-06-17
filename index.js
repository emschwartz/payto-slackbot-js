'use strict'

const slack = require('slack')
const request = require('superagent')
const Koa = require('koa')
const bodyparser = require('koa-bodyparser')
const route = require('koa-route')
const { URL } = require('url')
const crypto = require('crypto')

const SEND_REGEX = /^<@([a-z0-9]+)\|([a-z0-9]+)> (\d+\.?\d*) (.*)$/i
const REGISTER_REGEX = /^<(.*)\/register\/(.*)>$/
const USER_INFO_URL = 'https://slack.com/api/users.profile.get'

const spspFieldId = process.env.SPSP_FIELD_ID
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
app.context.credentialsStore = {}
app.use(verify(slackVerificationToken))
app.use(route.post('/payto/send', sendHandler))
app.use(route.post('/payto/register', registerHandler))

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

  const credentials = ctx.credentialsStore[body.user_id]
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
    spspAddress = user.profile.fields[spspFieldId].value
  } catch (err) {
    // TODO send a message to that user telling them someone tried to pay them but they need to set their SPSP Address
    return ctx.throw(422, `uh oh! it looks like @${params.name} doesn't have their SPSP Address sent in their profile`)
  }

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
    console.log('error sending payment', err)
    return sendError(body.response_url, 'Error: ' + err.message)
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
  ctx.body = {
    response_type: 'ephemeral',
    text: 'Registering...'
  }
  await next()

  // Get their email
  let email
  try {
    const user = await getUserInfo(body.user_id)
    const userEmail = user.profile.email || 'blah@example.com'
    email = userEmail.replace('@', '+' + username + '@')
  } catch (err) {
    return sendError(body.response_url, 'Error: could not get your email address from your Slack profile')
  }

  // Determine the account credentials
  const username = 'payto-' + body.user_name.slice(0,15) //+ '-' + crypto.randomBytes(4).toString('hex')
  const password = crypto.randomBytes(12).toString('base64')

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
        email
      })
    balance = registerResult.body.balance
    // TODO add profile picture from slack?
  } catch (err) {
    console.log(`error registering user ${username} on ilp kit ${ilpKitHost}`, err.statusCode, err.body || err)
    return sendError(body.response_url, `Error registering user ${username} on ${ilpKitHost}: ${err.message}`)
  }

  ctx.credentialsStore[body.user_id] = {
    ilpKitHost,
    username,
    password
  }

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
        user: id
      })
    return result.body
  } catch (err) {
    console.log('error getting user info', err)
    throw new Error('error getting user info: ' + err.status + ' ' + err.message)
  }
}

async function sendPayment ({ spspAddress, amount, message, credentials }) {
  console.log(`send SPSP payment for ${amount} to ${spspAddress} with message: "${message}" using credentials:`, credentials)

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
    console.log('error getting quote', err.statusCode, err.body)
    throw new Error('could not get quote :white_frowning_face:')
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
    console.log('error sending payment', err.statusCode, err.body || err)
    throw new Error('something went wrong while sending the payment')
  }

  return {
    sourceAmount: quote.sourceAmount
  }

}

console.log('listening on port: ' + port)
app.listen(port)
