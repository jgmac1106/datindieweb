const budo = require('budo')
const express = require('express')
const expressWebSocket = require('express-ws')
const bodyParser = require('body-parser')
const websocketStream = require('websocket-stream/stream')
const pump = require('pump')
const through2 = require('through2')
const ram = require('random-access-memory')
const hypercore = require('hypercore')
const hyperdiscovery = require('hyperdiscovery')
const prettyHash = require('pretty-hash')
const Multicore = require('./multicore')
const {createClient} = require('dat-pinning-service-client')

require('dotenv').config()

require('events').prototype._maxListeners = 100

let hashbaseClient
// Hashbase Pinning API
createClient('https://hashbase.io', {
  username: process.env.HASHBASE_USERNAME,
  password: process.env.HASHBASE_PASSWORD,
}, (err, client) => {
  if (err) {
    console.error('hashbase error', err)
    return
  }
  console.log('Jim hashbase logged in')
  hashbaseClient = client
})

// Run a cloud peer using pixelpusherd
// https://github.com/automerge/pixelpusherd

const defaultCloudPeers = [
//  'db26829a97db4a3f30b189357fab79c10c543c8e0a65a9d594eb3cb15e8aba1d'
  '82d3b86dc2f76f7ecf6e8764139881577820e3edd2259fbc9a4f899b0e47bbde'
]

const router = express.Router()

function indexHtml (req, res, next) {
  req.url = '/index.html'
  next()
}

router.get('/pages', indexHtml)
router.get('/page/:key', indexHtml)

router.post('/pin', (req, res) => {
  try {
    console.log('Jim post pin', req.body)
    const dashedTitle = req.body.title.toLowerCase().replace(/ /g, '-')
    console.log('Jim dashedTitle', dashedTitle)
    if (!hashbaseClient) return
    console.log('Pinning...')
    hashbaseClient.addDat({
      url: `dat://${req.body.key}/`,
      name: dashedTitle + '-indieweb'
      // domains: [`${dashedTitle}-indieweb.hashbase.io`]
    }, (err, result) => {
      console.log('Jim Hashbase API', err, result)
    })
  } catch (err) {
    console.log('Jim pin error', err)
  }
})

const multicores = {}

function attachWebsocket (server) {
  console.log('Attaching websocket')
  expressWebSocket(router, server, {
    perMessageDeflate: false
  })

  router.ws('/archiver/:key', (ws, req) => {
    const archiverKey = req.params.key
    console.log('Websocket initiated for', archiverKey)
    let multicore
    if (multicores[archiverKey]) {
      multicore = multicores[archiverKey]
    } else {
      multicore = new Multicore(ram, {key: archiverKey})
      multicores[archiverKey] = multicore
      const ar = multicore.archiver
      ar.on('add', feed => {
        console.log('archive add', feed.key.toString('hex'))
        multicore.replicateFeed(feed)
        feed.on('append', () => {
          console.log('append', prettyHash(feed.key), feed.length)
        })
        feed.on('sync', () => {
          console.log('sync', prettyHash(feed.key), feed.length)
        })
      })
      ar.on('add-archive', (metadata, content) => {
        console.log(
          'archive add-archive',
          metadata.key.toString('hex'),
          content.key.toString('hex')
        )
        content.on('append', () => {
          console.log(
            'append content',
            prettyHash(content.key),
            content.length
          )
        })
        content.on('sync', () => {
          console.log(
            'sync content',
            prettyHash(content.key),
            content.length
          )
        })
      })
      ar.on('sync', feed => {
        console.log('archive fully synced', prettyHash(feed.key))
      })
      ar.on('ready', () => {
        console.log('archive ready', ar.changes.length)
        ar.changes.on('append', () => {
          console.log('archive changes append', ar.changes.length)
        })
        ar.changes.on('sync', () => {
          console.log('archive changes sync', ar.changes.length)
        })
        // Join swarm
        const sw = multicore.joinSwarm()
        sw.on('connection', (peer, info) => {
          console.log('Swarm connection', info)
        })
        // Connect cloud peers
        connectCloudPeers(archiverKey)
      })
    }
    const ar = multicore.archiver
    ar.ready(() => {
      const stream = websocketStream(ws)
      pump(
        stream,
        through2(function (chunk, enc, cb) {
          // console.log('From web', chunk)
          this.push(chunk)
          cb()
        }),
        ar.replicate({encrypt: false}),
        through2(function (chunk, enc, cb) {
          // console.log('To web', chunk)
          this.push(chunk)
          cb()
        }),
        stream,
        err => {
          console.log('pipe finished', err.message)
        }
      )
      console.log(
        'Changes feed dk:',
        ar.changes.discoveryKey.toString('hex')
      )
      multicore.replicateFeed(ar.changes)
    })
  })
}

function connectCloudPeers (archiverKey) {
  const cloudPeers = defaultCloudPeers.reduce((acc, key) => {
    acc[key] = {}
    return acc
  }, {})
  Object.keys(cloudPeers).forEach(key => {
    console.log('Cloud peer connecting...', key)
    const feed = hypercore(ram, key)
    feed.ready(() => {
      // FIXME: We should encrypt this
      const userData = JSON.stringify({key: archiverKey})
      const sw = hyperdiscovery(feed, {
        stream: () => feed.replicate({userData})
      })
      sw.on('connection', peer => {
        let name
        try {
          if (peer.remoteUserData) {
            const json = JSON.parse(peer.remoteUserData.toString())
            name = json.name
            console.log('Connected to cloud peer', key, name)
          }
        } catch (e) {
          console.log('Cloud peer JSON parse error')
        }
        peer.on('error', err => {
          console.log('Cloud peer connection error', key, err)
        })
        peer.on('close', err => {
          console.log('Cloud peer connection closed', key, err)
        })
      })
    })
  })
}

const port = process.env.PORT || 5000
const devServer = budo('index.js', {
  port,
  browserify: {
    transform: [
      'brfs',
      ['sheetify', {transform: ['sheetify-nested']}]
    ]
  },
  middleware: [
    bodyParser.json(),
    router
  ]
})
devServer.on('connect', event => {
  console.log('Listening on', event.uri)
  attachWebsocket(event.server)
})
