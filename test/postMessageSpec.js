'use strict'

const _ = require('lodash')
const assert = require('assert')
const sinon = require('sinon')
const app = require('../src/services/app')
const logger = require('../src/services/log')
const dbHelper = require('./helpers/db')
const appHelper = require('./helpers/app')
const logHelper = require('./helpers/log')
const accounts = require('./data/accounts')
const timingHelper = require('./helpers/timing')

describe('POST /messages', function () {
  logHelper(logger)

  before(function * () {
    yield dbHelper.init()
  })

  beforeEach(function * () {
    appHelper.create(this, app)
    yield dbHelper.clean()
    this.exampleMessage = _.cloneDeep(require('./data/messages/simple'))
    this.fromToMessage = _.cloneDeep(require('./data/messages/fromto'))
    // Store some example data
    yield dbHelper.addAccounts(_.values(_.omit(accounts, 'noBalance')))

    this.socket = this.ws('http://localhost/websocket', {
      headers: {
        Authorization: 'Basic ' + new Buffer('bob:bob', 'utf8').toString('base64')
      }
    })

    // Wait until WS connection is established
    yield new Promise((resolve) => {
      this.socket.once('message', (msg) => {
        assert.deepEqual(JSON.parse(msg), { jsonrpc: '2.0', id: null, method: 'connect' })
        resolve()
      })
    })

    this.socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'subscribe_account',
      params: { eventType: 'message.send', accounts: ['http://localhost/accounts/bob'] }
    }))

    yield new Promise((resolve) => {
      this.socket.once('message', (msg) => {
        assert.deepEqual(JSON.parse(msg), { jsonrpc: '2.0', id: 1, result: 1 })
        resolve()
      })
    })
  })

  afterEach(function * () {
    this.socket.terminate()
  })

  it('returns 201 if the message is valid', function * () {
    const message = this.exampleMessage

    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(201)
      .end()
  })

  it('returns 201 if the message has "from", "to", and "account', function * () {
    const message = this.fromToMessage
    message.account = message.from

    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(201)
      .end()
  })

  it('returns 400 if the message is missing "ledger"', function * () {
    const message = this.exampleMessage
    delete message.ledger

    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(400)
      .end()
  })

  it('returns 400 if the message is missing "account"', function * () {
    const message = this.exampleMessage
    delete message.account

    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(400)
      .end()
  })

  it('returns 400 if the message has "from" but no "to"', function * () {
    const message = this.fromToMessage
    delete message.to

    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(400)
      .end()
  })

  it('returns 400 if the message has "to" but no "from"', function * () {
    const message = this.fromToMessage
    delete message.from

    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(400)
      .end()
  })

  it('returns 400 if the message is missing "data"', function * () {
    const message = this.exampleMessage
    delete message.data

    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(400)
      .end()
  })

  it('returns 400 if "from" doesn\'t match the sender (when the sender isn\'t admin)', function * () {
    const message = this.fromToMessage
    message.from = 'http://localhost/accounts/carl'

    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(400)
      .expect({
        id: 'InvalidBodyError',
        message: 'You do not have permission to impersonate this user'
      })
      .end()
  })

  it('returns 422 if the message recipient isn\'t listening', function * () {
    const message = Object.assign(this.exampleMessage, {
      account: 'http://localhost/accounts/carl'
    })

    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(422)
      .expect({
        id: 'NoSubscriptionsError',
        message: 'Destination account could not be reached'
      })
      .end()
  })

  it('relays a message with "account"', function * () {
    const message = this.exampleMessage
    const listener = sinon.spy()
    this.socket.on('message', (msg) => listener(JSON.parse(msg)))

    yield timingHelper.sleep(50)
    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(201)
      .end()
    yield timingHelper.sleep(50)

    sinon.assert.calledOnce(listener)
    sinon.assert.calledWith(listener.firstCall, {
      jsonrpc: '2.0',
      id: null,
      method: 'notify',
      params: {
        event: 'message.send',
        resource: {
          ledger: 'http://localhost',
          from: 'http://localhost/accounts/alice',
          to: 'http://localhost/accounts/bob',
          account: 'http://localhost/accounts/alice',
          data: {foo: 'bar'}
        }
      }
    })
  })

  it('relays a message with "from"/"to"', function * () {
    const message = this.fromToMessage
    const listener = sinon.spy()
    this.socket.on('message', (msg) => listener(JSON.parse(msg)))

    yield timingHelper.sleep(50)
    yield this.request()
      .post('/messages')
      .auth('alice', 'alice')
      .send(message)
      .expect(201)
      .end()
    yield timingHelper.sleep(50)

    sinon.assert.calledOnce(listener)
    sinon.assert.calledWith(listener.firstCall, {
      jsonrpc: '2.0',
      id: null,
      method: 'notify',
      params: {
        event: 'message.send',
        resource: {
          ledger: 'http://localhost',
          from: 'http://localhost/accounts/alice',
          to: 'http://localhost/accounts/bob',
          account: 'http://localhost/accounts/alice',
          data: {foo: 'bar'}
        }
      }
    })
  })

  it('relays a message when the admin is impersonating another user', function * () {
    const message = this.fromToMessage
    const listener = sinon.spy()
    this.socket.on('message', (msg) => listener(JSON.parse(msg)))

    yield timingHelper.sleep(50)
    yield this.request()
      .post('/messages')
      .auth('admin', 'admin')
      .send(message)
      .expect(201)
      .end()
    yield timingHelper.sleep(50)

    sinon.assert.calledOnce(listener)
    sinon.assert.calledWith(listener.firstCall, {
      jsonrpc: '2.0',
      id: null,
      method: 'notify',
      params: {
        event: 'message.send',
        resource: {
          ledger: 'http://localhost',
          from: 'http://localhost/accounts/alice',
          to: 'http://localhost/accounts/bob',
          account: 'http://localhost/accounts/alice',
          data: {foo: 'bar'}
        }
      }
    })
  })
})
