import 'dotenv/config'
import express from 'express'
import nodeCleanup from 'node-cleanup'
import routes from './routes.js'
import { init, cleanup, getSession, deleteSession } from './whatsapp.js'
import cors from 'cors'

const app = express()

const host = process.env.WA_SERVER_HOST || undefined
const port = parseInt(process.env.WA_SERVER_PORT ?? 8000)

app.use(cors())
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use('/', routes)

const listenerCallback = () => {
    init()
    console.log(`Server is listening on http://${host ? host : 'localhost'}:${port}`)
}

if (host) {
    app.listen(port, host, listenerCallback)
} else {
    app.listen(port, listenerCallback)
}

nodeCleanup(cleanup)


// Add these handlers for proper cleanup
process.on('SIGINT', async () => {
    console.log('Running cleanup before exit.')
    cleanup()
    process.exit(0)
})

process.on('SIGTERM', async () => {
    console.log('Running cleanup before exit.')
    cleanup()
    process.exit(0)
})

process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error)
    cleanup()
    process.exit(1)
})


export default app