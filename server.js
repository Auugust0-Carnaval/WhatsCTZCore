const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const cors = require('cors');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const pino = require('pino');
const multer = require('multer');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();

// Configuração do logger sem pino-pretty
const logger = pino({
    level: 'info',
    // Removido o transport que causava erro
});

// Logger mais simples para console
const log = {
    info: (...args) => console.log('[INFO]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    success: (...args) => console.log('[SUCCESS]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args)
};

app.use(cors({
    origin: [
        'http://localhost:8080',
        'http://localhost:3001',
        'https://ctzbuilder.onrender.com',
        'http://localhost:3000'
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

let sock = null;
let qrCodeData = null;
let qrCodeBase64 = null;
let connectionAttempts = 0;

// ========== NOVAS CONSTANTES PARA RECONEXÃO ==========
const MAX_RECONNECT_ATTEMPTS = 50;
const BASE_RECONNECT_DELAY = 2000;
let reconnectAttempts = 0;
let isReconnecting = false;
let lastConnectionTime = null;
let heartbeatInterval = null;
let sessionCheckInterval = null;

// Criar diretório de autenticação se não existir
const authDir = path.join(process.cwd(), 'auth_info_baileys');
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

const msgRetryCounterCache = new NodeCache({ stdTTL: 60 });

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos PDF são permitidos!'), false);
        }
    }
});

// ========== NOVAS FUNÇÕES ==========

// Função para limpar credenciais corrompidas
async function cleanupCorruptedAuth() {
    try {
        log.warn('🧹 Limpando credenciais corrompidas...');
        
        // Backup das credenciais antigas (opcional)
        const backupDir = path.join(process.cwd(), 'auth_backup_' + Date.now());
        if (fs.existsSync(authDir)) {
            fs.cpSync(authDir, backupDir, { recursive: true, force: true });
            log.info(`📦 Backup criado em: ${backupDir}`);
        }
        
        // Remove diretório atual
        fs.rmSync(authDir, { recursive: true, force: true });
        fs.mkdirSync(authDir, { recursive: true });
        
        log.success('✅ Credenciais limpas com sucesso');
        return true;
    } catch (error) {
        log.error('Erro ao limpar credenciais:', error);
        return false;
    }
}

// Função para verificar validade da sessão
async function isSessionValid() {
    try {
        if (!sock || !sock.user) return false;
        
        // Verifica se ainda está conectado enviando um ping
        await sock.sendPresenceUpdate('available');
        
        // Atualiza timestamp da última conexão válida
        lastConnectionTime = Date.now();
        reconnectAttempts = 0;
        
        return true;
    } catch (error) {
        log.warn('⚠️ Sessão inválida detectada');
        return false;
    }
}

// Função para limpar intervalos
function clearIntervals() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    if (sessionCheckInterval) {
        clearInterval(sessionCheckInterval);
        sessionCheckInterval = null;
    }
}

// Função para reconexão inteligente
async function smartReconnect() {
    if (isReconnecting) return;
    
    isReconnecting = true;
    
    try {
        // Verifica se a sessão ainda é válida
        const valid = await isSessionValid();
        
        if (valid) {
            log.success('✅ Sessão ainda válida');
            isReconnecting = false;
            return;
        }
        
        reconnectAttempts++;
        
        // Se muitas tentativas, limpa credenciais
        if (reconnectAttempts > 10) {
            log.warn(`⚠️ Muitas tentativas (${reconnectAttempts}), limpando credenciais...`);
            await cleanupCorruptedAuth();
            reconnectAttempts = 0;
            qrCodeData = null;
            qrCodeBase64 = null;
        }
        
        // Delay exponencial com jitter
        const delay = Math.min(
            BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts) + Math.random() * 1000,
            30000 // Max 30 segundos
        );
        
        log.info(`🔄 Tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} em ${Math.round(delay/1000)}s`);
        
        setTimeout(async () => {
            try {
                await connectWhatsApp();
            } catch (error) {
                log.error('Erro na reconexão:', error);
            } finally {
                isReconnecting = false;
            }
        }, delay);
        
    } catch (error) {
        log.error('Erro no smartReconnect:', error);
        isReconnecting = false;
    }
}

// ========== FUNÇÃO PRINCIPAL MODIFICADA ==========

async function connectWhatsApp() {
    try {
        // Limpa intervals antigos
        clearIntervals();
        
        connectionAttempts++;
        log.info(`Tentativa de conexão #${connectionAttempts}`);
        
        const { version, isLatest } = await fetchLatestBaileysVersion();
        log.info(`📱 Usando WA v${version.join('.')}, latest: ${isLatest}`);

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['Chrome (Linux)', 'Main', '20.0.04'],
            syncFullHistory: false,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 15000, // Reduzido para 15s
            msgRetryCounterCache,
            logger: pino({ level: 'silent' }),
            generateHighQualityLinkPreview: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            maxRetries: 5,
            retryRequestDelayMs: 500,
            
            // Novas opções para manter conexão
            shouldSyncHistory: false,
            fireInitQueries: false,
            emitOwnEvents: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrCodeData = qr;
                connectionAttempts = 0;
                reconnectAttempts = 0;
                
                log.info('\n' + '='.repeat(60));
                log.info('🔐 QR CODE GERADO - Escaneie com WhatsApp');
                log.info('='.repeat(60));
                
                // Método 1: URL online (MAIS CONFIÁVEL)
                try {
                    const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(qr)}&size=300x300`;
                    log.info('📱 LINK PARA ESCANEAR (copie e cole no navegador):');
                    log.info(qrUrl);
                    log.info('\nOu acesse:');
                } catch (err) {
                    log.error('Erro ao gerar URL:', err);
                }
                
                // Método 2: Base64
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr);
                    log.info('📱 Acesse a rota /qr-view no seu navegador');
                } catch (err) {
                    log.error('Erro ao gerar base64:', err);
                }
                
                // Método 3: Terminal (tentativa)
                try {
                    const qrcodeTerminal = require('qrcode-terminal');
                    console.log('\n📱 QR Code no terminal (tente escanear):\n');
                    qrcodeTerminal.generate(qr, { small: false });
                } catch (err) {
                    // Ignora erro do terminal
                }
                
                log.info('='.repeat(60) + '\n');
            }

            if (connection === 'open') {
                qrCodeData = null;
                qrCodeBase64 = null;
                connectionAttempts = 0;
                reconnectAttempts = 0;
                lastConnectionTime = Date.now();
                log.success('✅ WhatsApp conectado com sucesso!');
                log.success(`👤 Conectado como: ${sock.user?.name || sock.user?.id || 'Desconhecido'}`);
                
                // Envia heartbeat periódico
                heartbeatInterval = setInterval(() => {
                    if (sock?.user) {
                        sock.sendPresenceUpdate('available').catch(() => {});
                    }
                }, 60000);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error instanceof Boom 
                    ? lastDisconnect.error.output?.statusCode 
                    : null;
                
                const errorMessage = lastDisconnect?.error?.message || '';
                
                log.error(`❌ Conexão fechada. Código: ${statusCode}, Erro: ${errorMessage}`);
                
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isConnectionLost = statusCode === DisconnectReason.connectionLost;
                const isRestartRequired = statusCode === DisconnectReason.restartRequired;
                
                if (isLoggedOut) {
                    log.warn('🚪 Deslogado do WhatsApp, necessário novo QR code');
                    await cleanupCorruptedAuth();
                    qrCodeData = null;
                    qrCodeBase64 = null;
                }
                
                // Reconecta se não for logout intencional
                if (!isLoggedOut) {
                    smartReconnect();
                }
            }
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            log.info('📝 Credenciais atualizadas');
            
            // Se as credenciais foram atualizadas, testa a conexão
            setTimeout(async () => {
                const valid = await isSessionValid();
                if (!valid) {
                    log.warn('⚠️ Credenciais atualizadas mas sessão inválida');
                }
            }, 2000);
        });

        // Adiciona handler para mensagens de keep-alive
        sock.ev.on('messages.upsert', (m) => {
            // Atualiza timestamp em qualquer atividade
            lastConnectionTime = Date.now();
        });

    } catch (error) {
        log.error('Erro na conexão:', error.message);
        smartReconnect();
    }
}

// ========== VERIFICAÇÃO PERIÓDICA DA SESSÃO ==========

// Verificação periódica da sessão
sessionCheckInterval = setInterval(async () => {
    if (sock?.user) {
        const valid = await isSessionValid().catch(() => false);
        
        // Se passou muito tempo sem atividade, reconecta
        const idleTime = Date.now() - (lastConnectionTime || 0);
        if (!valid && idleTime > 5 * 60 * 1000) { // 5 minutos idle
            log.warn('⚠️ Sessão inativa detectada, reconectando...');
            smartReconnect();
        }
    }
}, 2 * 60 * 1000); // A cada 2 minutos

// ========== NOVOS ENDPOINTS ==========

// Endpoint para renovar sessão
app.post('/renew-session', async (req, res) => {
    try {
        const { force } = req.body;
        
        log.info('🔄 Solicitada renovação de sessão');
        
        // Fecha conexão atual se existir
        if (sock) {
            try {
                sock.end(undefined);
                sock = null;
            } catch (e) {
                // Ignora erro ao fechar
            }
        }
        
        // Se forçar, limpa credenciais
        if (force) {
            await cleanupCorruptedAuth();
            qrCodeData = null;
            qrCodeBase64 = null;
        }
        
        // Reconecta
        setTimeout(() => {
            connectWhatsApp();
        }, 1000);
        
        res.json({ 
            success: true, 
            message: force ? 'Sessão renovada com força total' : 'Reconectando...',
            requiresQR: !sock?.user && !qrCodeData
        });
        
    } catch (error) {
        log.error('Erro ao renovar sessão:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para limpar credenciais
app.post('/clear-credentials', async (req, res) => {
    try {
        await cleanupCorruptedAuth();
        
        if (sock) {
            sock.end(undefined);
            sock = null;
        }
        
        qrCodeData = null;
        qrCodeBase64 = null;
        
        setTimeout(connectWhatsApp, 2000);
        
        res.json({ success: true, message: 'Credenciais limpas com sucesso' });
        
    } catch (error) {
        log.error('Erro ao limpar credenciais:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== ENDPOINTS EXISTENTES (MODIFICADOS) ==========

// Rota principal com HTML para visualizar QR
app.get('/', (req, res) => {
    const status = sock?.user ? 'connected' : (qrCodeData ? 'qr_ready' : 'disconnected');
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Bot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: Arial; max-width: 800px; margin: 0 auto; padding: 20px; text-align: center; }
                .card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; }
                .connected { color: green; }
                .disconnected { color: red; }
                .qr-container { margin: 20px auto; }
                img { max-width: 100%; height: auto; border: 1px solid #ddd; }
                .button { display: inline-block; padding: 10px 20px; margin: 10px; background: #25D366; color: white; text-decoration: none; border-radius: 5px; }
                .info { color: #666; margin: 10px; }
                pre { background: #f4f4f4; padding: 10px; border-radius: 5px; text-align: left; overflow-x: auto; }
                .danger-btn { background: #dc3545; }
            </style>
        </head>
        <body>
            <h1>🤖 WhatsApp Bot</h1>
            
            <div class="card">
                <h2>Status: <span class="${status === 'connected' ? 'connected' : 'disconnected'}">${status}</span></h2>
                
                ${sock?.user ? `
                    <p>✅ Conectado como: <strong>${sock.user.name || sock.user.id}</strong></p>
                    <p>🕒 Última atividade: ${new Date(lastConnectionTime || Date.now()).toLocaleString()}</p>
                ` : ''}
            </div>
            
            ${qrCodeData ? `
                <div class="card">
                    <h2>📱 Escaneie o QR Code</h2>
                    <div class="qr-container">
                        <img src="/qr-image" alt="QR Code">
                    </div>
                    <div class="info">
                        <p>1. Abra o WhatsApp no seu celular</p>
                        <p>2. Toque em Menu (⋮) ou Configurações</p>
                        <p>3. Selecione "WhatsApp Web"</p>
                        <p>4. Escaneie este código</p>
                    </div>
                    <a href="${`https://quickchart.io/qr?text=${encodeURIComponent(qrCodeData)}&size=300x300`}" target="_blank" class="button">Abrir QR em nova aba</a>
                </div>
            ` : ''}
            
            <div class="card">
                <h3>📋 Endpoints da API</h3>
                <pre>
GET  /status           - Status da conexão
GET  /qr               - Dados do QR (JSON)
GET  /qr-image         - Imagem do QR
POST /send-message     - Enviar mensagem
POST /send-pdf         - Enviar PDF
POST /renew-session    - Renovar sessão
POST /clear-credentials - Limpar credenciais
                </pre>
            </div>
            
            <div class="card">
                <h3>🛠️ Ações</h3>
                <button onclick="renewSession(false)" class="button">Renovar Sessão</button>
                <button onclick="renewSession(true)" class="button danger-btn">Forçar Renovação</button>
                <button onclick="clearCredentials()" class="button danger-btn">Limpar Credenciais</button>
            </div>
            
            <p><small>Servidor rodando em: ${baseUrl}</small></p>
            
            <script>
                async function renewSession(force) {
                    try {
                        const response = await fetch('/renew-session', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ force })
                        });
                        const data = await response.json();
                        alert(data.message);
                        setTimeout(() => location.reload(), 2000);
                    } catch (error) {
                        alert('Erro: ' + error.message);
                    }
                }
                
                async function clearCredentials() {
                    if (confirm('Tem certeza? Isso vai desconectar o WhatsApp e exigir novo QR Code.')) {
                        try {
                            const response = await fetch('/clear-credentials', { method: 'POST' });
                            const data = await response.json();
                            alert(data.message);
                            setTimeout(() => location.reload(), 2000);
                        } catch (error) {
                            alert('Erro: ' + error.message);
                        }
                    }
                }
                
                setTimeout(() => location.reload(), 30000);
            </script>
        </body>
        </html>
    `);
});

app.get('/qr', (req, res) => {
    if (qrCodeData) {
        res.json({ 
            success: true,
            qr: qrCodeData,
            qrBase64: qrCodeBase64,
            qrUrl: `https://quickchart.io/qr?text=${encodeURIComponent(qrCodeData)}&size=300x300`,
            message: 'QR Code disponível'
        });
    } else {
        res.json({ 
            success: false,
            qr: null, 
            qrBase64: null,
            message: sock?.user ? 'Já conectado' : 'QR não disponível'
        });
    }
});

app.get('/qr-image', async (req, res) => {
    if (!qrCodeData) {
        return res.status(404).send('QR Code não disponível');
    }
    
    try {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        
        const qrBuffer = await QRCode.toBuffer(qrCodeData, {
            width: 400,
            margin: 2,
            errorCorrectionLevel: 'H'
        });
        
        res.send(qrBuffer);
    } catch (error) {
        log.error('Erro ao gerar imagem QR:', error);
        res.status(500).send('Erro ao gerar imagem do QR');
    }
});

app.get('/qr-view', (req, res) => {
    res.redirect('/');
});

app.get('/status', (req, res) => {
    res.json({
        connected: sock?.user ? true : false,
        user: sock?.user ? {
            id: sock.user.id,
            name: sock.user.name || 'Desconhecido',
            devices: sock.user.devices || []
        } : null,
        hasQR: !!qrCodeData,
        attempts: connectionAttempts,
        reconnectAttempts: reconnectAttempts,
        lastActivity: lastConnectionTime,
        timestamp: new Date().toISOString()
    });
});

// Endpoint para enviar PDF
app.post('/send-pdf', upload.single('file'), async (req, res) => {
    try {
        log.info('📄 Requisição para enviar PDF recebida');
        
        const { number, caption } = req.body;
        
        if (!sock?.user) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        if (!number) {
            return res.status(400).json({ error: 'Número do WhatsApp não fornecido' });
        }

        // Formatar número
        let cleanNumber = number.replace(/\D/g, '');
        
        // Adicionar código do Brasil se necessário
        if (cleanNumber.length <= 11 && !cleanNumber.startsWith('55')) {
            cleanNumber = `55${cleanNumber}`;
        }

        const jid = `${cleanNumber}@s.whatsapp.net`;
        log.info(`📱 Enviando para: ${jid}`);
        
        const fileName = req.file.originalname || 'documento.pdf';
        
        await sock.sendMessage(jid, {
            document: req.file.buffer,
            mimetype: 'application/pdf',
            fileName: fileName,
            caption: caption || '📄 Documento enviado'
        });
        
        log.success(`✅ PDF enviado para ${cleanNumber}`);
        lastConnectionTime = Date.now(); // Atualiza timestamp
        
        res.json({ 
            success: true, 
            message: 'PDF enviado com sucesso!',
            fileName: fileName,
            number: cleanNumber
        });
        
    } catch (error) {
        log.error('❌ Erro ao enviar PDF:', error);
        res.status(500).json({ 
            error: 'Erro ao enviar PDF',
            details: error.message 
        });
    }
});

// Endpoint para enviar mensagem de texto
app.post('/send-message', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        if (!sock?.user) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        if (!number || !message) {
            return res.status(400).json({ error: 'Número e mensagem são obrigatórios' });
        }

        let cleanNumber = number.replace(/\D/g, '');
        
        if (cleanNumber.length <= 11 && !cleanNumber.startsWith('55')) {
            cleanNumber = `55${cleanNumber}`;
        }

        const jid = `${cleanNumber}@s.whatsapp.net`;
        
        await sock.sendMessage(jid, { text: message });
        lastConnectionTime = Date.now(); // Atualiza timestamp
        
        res.json({ success: true, message: 'Mensagem enviada!' });
        
    } catch (error) {
        log.error('Erro ao enviar mensagem:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== INICIALIZAÇÃO ==========

// Iniciar conexão
connectWhatsApp();

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    log.success('\n' + '='.repeat(50));
    log.success('🚀 SERVIDOR INICIADO COM SUCESSO!');
    log.success('='.repeat(50));
    log.info(`📱 Porta: ${PORT}`);
    
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    log.info(`🌐 URL: ${baseUrl}`);
    log.info('\n📌 Para escanear o QR Code:');
    log.info(`   1. Acesse: ${baseUrl}`);
    log.info(`   2. Ou acesse: ${baseUrl}/qr-view`);
    log.info('   3. Escaneie com o WhatsApp\n');
});

// ========== CLEANUP NA FINALIZAÇÃO ==========

process.on('SIGINT', () => {
    log.info('🛑 Encerrando servidor...');
    clearIntervals();
    if (sock) {
        sock.end(undefined);
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    log.info('🛑 Encerrando servidor...');
    clearIntervals();
    if (sock) {
        sock.end(undefined);
    }
    process.exit(0);
});