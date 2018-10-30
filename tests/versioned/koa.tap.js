'use strict'

const tap = require('tap')
const utils = require('@newrelic/test-utilities')
const http = require('http')
const semver = require('semver')

utils(tap)

tap.test('Koa instrumentation', (t) => {
  let helper = null
  let app = null
  let server = null

  t.beforeEach((done) => {
    helper = utils.TestAgent.makeInstrumented()
    helper.registerInstrumentation({
      moduleName: 'koa',
      type: 'web-framework',
      onRequire: require('../../lib/instrumentation')
    })
    const Koa = require('koa')
    app = new Koa()
    done()
  })

  t.afterEach((done) => {
    server && server.close()
    app = null
    helper && helper.unload()
    done()
  })

  t.test('names the transaction after the middleware that sets the body', (t) => {
    app.use(function one(ctx, next) {
      const tx = helper.getTransaction()
      tx.nameState.appendPath('one-start')
      return next().then(() => tx.nameState.appendPath('one-end'))
    })

    app.use(function two(ctx) {
      const tx = helper.getTransaction()
      tx.nameState.appendPath('two')
      ctx.body = 'done'
    })

    helper.agent.on('transactionFinished', (tx) => {
      t.equal(
        tx.name,
        'WebTransaction/WebFrameworkUri/Koa/GET//one-start/two',
        'should have name without post-response name info'
      )
      t.end()
    })

    run()
  })

  t.test('names the transaction after the last middleware that sets the body', (t) => {
    app.use(function one(ctx, next) {
      const tx = helper.getTransaction()
      tx.nameState.appendPath('one-start')
      return next().then(() => tx.nameState.appendPath('one-end'))
    })

    app.use(function two(ctx, next) {
      const tx = helper.getTransaction()
      tx.nameState.appendPath('two')
      ctx.body = 'not actually done'
      return next()
    })

    app.use(function three(ctx) {
      const tx = helper.getTransaction()
      tx.nameState.appendPath('three')
      ctx.body = 'done'
    })

    helper.agent.on('transactionFinished', (tx) => {
      t.equal(
        tx.name,
        'WebTransaction/WebFrameworkUri/Koa/GET//one-start/two/three',
        'should have name without post-response name info'
      )
      t.end()
    })

    run()
  })

  t.test('names the transaction off the status setting middleware', (t) => {
    app.use(function one(ctx, next) {
      const tx = helper.getTransaction()
      tx.nameState.appendPath('one-start')
      return next().then(() => tx.nameState.appendPath('one-end'))
    })

    app.use(function two(ctx) {
      const tx = helper.getTransaction()
      tx.nameState.appendPath('two')
      ctx.status = 200
    })

    helper.agent.on('transactionFinished', (tx) => {
      t.equal(
        tx.name,
        'WebTransaction/WebFrameworkUri/Koa/GET//one-start/two',
        'should have name without post-response name info'
      )
      t.end()
    })

    run()
  })

  t.test('names the transaction when body set even if status set after', (t) => {
    app.use(function one(ctx, next) {
      const tx = helper.getTransaction()
      tx.nameState.appendPath('one-start')
      return next().then(() => tx.nameState.appendPath('one-end'))
    })

    app.use(function two(ctx) {
      const tx = helper.getTransaction()
      tx.nameState.appendPath('two')
      ctx.body = 'done'

      tx.nameState.appendPath('setting-status')
      ctx.status = 200
    })

    helper.agent.on('transactionFinished', (tx) => {
      t.equal(
        tx.name,
        'WebTransaction/WebFrameworkUri/Koa/GET//one-start/two',
        'should have name without post-response name info'
      )
      t.end()
    })

    run()
  })

  t.test('produces transaction trace with multiple middleware', (t) => {
    app.use(function one(ctx, next) {
      return next()
    })
    app.use(function two(ctx) {
      ctx.response.body = 'done'
    })

    helper.agent.on('transactionFinished', (tx) => {
      checkSegments(t, tx)
    })

    run()
  })

  t.test('correctly records actions interspersed among middleware', (t) => {
    app.use(function one(ctx, next) {
      helper.agent.tracer.createSegment('testSegment')
      return next().then(function() {
        helper.agent.tracer.createSegment('nestedSegment')
      })
    })
    app.use(function two(ctx, next) {
      return new Promise(function(resolve) {
        setTimeout(resolve, 10)
      })
      .then(next)
    })
    app.use(function three(ctx) {
      ctx.body = 'done'
    })

    helper.agent.on('transactionFinished', (tx) => {
      // Node < 6 produces a different tx trace structure, due to differences
      // in Promise implementation.
      if (semver.lt(process.version, '6.0.0')) {
        t.exactSegments(tx.trace.root, [
          {
            name: 'WebTransaction/WebFrameworkUri/Koa/GET//',
            children: [{
              name: 'Nodejs/Middleware/Koa/one',
              children: [
                {name: 'Truncated/testSegment'},
                {
                  name: 'Nodejs/Middleware/Koa/two',
                  children: [
                    {name: 'timers.setTimeout'},
                    {name: 'Nodejs/Middleware/Koa/three'},
                    {name: 'Truncated/nestedSegment'}
                  ]
                }
              ]
            }]
          }
        ])
      } else {
        t.exactSegments(tx.trace.root, [
          {
            name: 'WebTransaction/WebFrameworkUri/Koa/GET//',
            children: [{
              name: 'Nodejs/Middleware/Koa/one',
              children: [
                {name: 'Truncated/testSegment'},
                {
                  name: 'Nodejs/Middleware/Koa/two',
                  children: [
                    {name: 'timers.setTimeout'},
                    {name: 'Nodejs/Middleware/Koa/three'}
                  ]
                },
                {name: 'Truncated/nestedSegment'}
              ]
            }]
          }
        ])
      }
      t.end()
    })

    run()
  })

  // THIS TEST WILL ONLY PASS IN CASES WHEN { await_support: true }.
  // TRANSACTION CONTEXT IS NOT MAINTAINED BELOW NODE 8, AND REQUIRES
  // CHANGES TO THE PROMISE INSTRUMENTATION.
  //
  // t.test('maintains transaction state between middleware', (t) => {
  //   var tasks = []
  //   var intervalId = setInterval(function() {
  //     while (tasks.length) {
  //       tasks.pop()()
  //     }
  //   }, 10)

  //   t.tearDown(function() {
  //     clearInterval(intervalId)
  //   })
  //   var tx

  //   app.use(function one(ctx, next) {
  //     tx = helper.agent.getTransaction()
  //     return new Promise(executor)

  //     function executor(resolve) {
  //       tasks.push(function() {
  //         next().then(function() {
  //           t.transaction(tx)
  //           resolve()
  //         })
  //       })
  //     }
  //   })
  //   app.use(function two(ctx, next) {
  //     t.transaction(tx, 'two has transaction context')
  //     return next()
  //   })
  //   app.use(function three(ctx) {
  //     t.transaction(tx, 'three has transaction context')
  //     ctx.body = 'done'
  //   })

  //   helper.agent.on('transactionFinished', function(txn) {
  //     checkSegments(t, txn)
  //   })

  //   run()
  // })

  t.test('errors handled within middleware are not recorded', (t) => {
    app.use(function one(ctx, next) {
      return next().catch(function(err) {
        t.equal(err.message, 'middleware error', 'caught expected error')
        ctx.status = 200
        ctx.body = 'handled error'
      })
    })
    app.use(function two(ctx) {
      throw new Error('middleware error')
      ctx.body = 'done'
    })

    helper.agent.on('transactionFinished', (tx) => {
      var errors = helper.agent.errors.errors
      t.equal(errors.length, 0, 'no errors are recorded')
      checkSegments(t, tx)
    })

    run()
  })

  t.test('errors not handled by middleware are recorded', (t) => {
    app.use(function one(ctx, next) {
      return next().catch(function(err) {
        t.equal(err.message, 'middleware error', 'caught expected error')
        ctx.status = 500
        ctx.body = 'error is not actually handled'
      })
    })
    app.use(function two() {
      throw new Error('middleware error')
    })

    helper.agent.on('transactionFinished', (tx) => {
      var errors = helper.agent.errors.errors
      t.equal(errors.length, 1, 'recorded expected number of errors')
      var error = errors[0][2]
      t.equal(error, 'middleware error', 'recorded expected error')
      checkSegments(t, tx)
    })
    run()
  })

  t.test('errors caught by default error listener are recorded', (t) => {
    app.use(function one(ctx, next) {
      return next()
    })
    app.use(function two() {
      throw new Error('middleware error')
    })
    app.on('error', function(err) {
      t.equal(err.message, 'middleware error', 'caught expected error')
    })

    helper.agent.on('transactionFinished', (tx) => {
      var errors = helper.agent.errors.errors
      t.equal(errors.length, 1, 'recorded expected number of errors')
      var error = errors[0][2]
      t.equal(error, 'middleware error', 'recorded expected error')
      checkSegments(t, tx)
    })
    run()
  })

  t.autoend()

  function run() {
    server = app.listen(0, function() {
      http.get({port: server.address().port}, function(res) {
        if (res.body) {
          t.equal(res.body, 'done')
        }
      }).end()
    })
  }
})

function checkSegments(t, tx) {
  t.exactSegments(
    tx.trace.root,
    [{
      // Until koa-router is instrumented and transaction naming is addressed,
      // names will be inconsistent depending on whether there is an error.
      name: tx.name,
      children: [{
        name: 'Nodejs/Middleware/Koa/one',
        children: [
          {name: 'Nodejs/Middleware/Koa/two'}
        ]
      }]
    }],
    'segments have expected names'
  )
  t.end()
}
