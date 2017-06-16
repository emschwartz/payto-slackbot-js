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
      err.status = 403
      err.expose = true
      throw err
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
  let spspAddress
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
    const user = await getUserInfo(params.id)
    spspAddress = user.profile.fields[spspFieldId].value
  } catch (err) {
    console.log(err)
    err.expose = true
    err.status = 422
    throw err
  }

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
    return request.post(body.response_url)
      .send({
        text: 'Error: ' + err.message
      })
  }

  const result = await request.post(body.response_url)
    .send({
      text: `Sent! (source amount: ${paymentResult.sourceAmount})`
    })
}

async function registerHandler (ctx, next) {
  const body = ctx.request.body
  console.log('register got body', body)

  let ilpKitHost
  let inviteCode
  let userEmail
  try {
    const match = REGISTER_REGEX.exec(body.text)
    ilpKitHost = match[1]
    inviteCode = match[2]

    const user = await getUserInfo(body.user_id)
    userEmail = user.profile.email || 'blah@example.com'
  } catch (err) {
    console.log('got invalid registration request', body)
    return request.post(body.response_url)
      .send({
        text: 'Error: registration request must include invite code URL from an ILP Kit'
      })
  }

  const username = 'payto-' + body.user_name.slice(0,15) //+ '-' + crypto.randomBytes(4).toString('hex')
  const password = crypto.randomBytes(12).toString('base64')
  const email = userEmail.replace('@', '+' + username + '@')

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
    return request.post(body.response_url)
      .send({
        text: `Error registering user ${username} on ${ilpKitHost}: ${err.message}`
      })
  }

  ctx.credentialsStore[body.user_id] = {
    ilpKitHost,
    username,
    password
  }

  console.log(`created account ${accountUrl}, balance is ${balance}`)

  // TODO respond to request faster so that we don't end up with two messages
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
    throw new Error('could not get quote')
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
