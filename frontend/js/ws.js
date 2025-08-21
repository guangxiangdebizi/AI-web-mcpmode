// ws.js - WebSocket 封装类
class WebSocketManager {
    constructor() {
        this.ws = null;
        this.url = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000; // 1秒
        this.heartbeatInterval = null;
        this.heartbeatDelay = 30000; // 30秒
        this.isConnecting = false;
        this.isManualClose = false;
        this.isInitialized = false;
        
        // 事件回调
        this.onOpen = null;
        this.onMessage = null;
        this.onClose = null;
        this.onError = null;
        this.onReconnecting = null;
    }
    
    async initialize() {
        if (this.isInitialized) return;
        
        try {
            // 确保配置管理器已加载
            if (!window.configManager.isLoaded) {
                console.log('🔄 等待配置文件加载...');
                await window.configManager.loadConfig();
            }
            
            // 获取WebSocket URL
            this.url = window.configManager.getSmartWebSocketUrl('/ws/chat');
            // 将页面 URL 的 msid 透传到 WebSocket 连接
            try {
                const urlParams = new URLSearchParams(window.location.search || '');
                const msid = urlParams.get('msid');
                if (msid) {
                    const hasQuery = this.url.includes('?');
                    this.url = this.url + (hasQuery ? '&' : '?') + 'msid=' + encodeURIComponent(msid);
                }
                // 透传模型档位（若有选择）
                const chosenModel = localStorage.getItem('mcp_selected_model');
                if (chosenModel) {
                    const hasQuery2 = this.url.includes('?');
                    this.url = this.url + (hasQuery2 ? '&' : '?') + 'model=' + encodeURIComponent(chosenModel);
                }
            } catch (e) {
                console.warn('⚠️ 解析页面参数失败:', e);
            }
            this.isInitialized = true;
            
            console.log('🔧 WebSocket 初始化完成, URL:', this.url);
        } catch (error) {
            console.error('❌ WebSocket 初始化失败:', error);
            this.isInitialized = false;
            
            // 不提供任何默认URL，直接抛出错误
            throw new Error(`WebSocket 初始化失败: ${error.message}。请确保 config.json 文件存在且配置正确。`);
        }
    }
    
    async connect() {
        if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
            return;
        }
        
        // 确保已初始化
        if (!this.isInitialized) {
            try {
                await this.initialize();
            } catch (error) {
                console.error('❌ WebSocket 初始化失败，无法连接:', error);
                if (this.onError) {
                    this.onError(error);
                }
                return;
            }
        }
        
        if (!this.url) {
            const error = new Error('WebSocket URL 未设置，无法连接');
            console.error('❌', error.message);
            if (this.onError) {
                this.onError(error);
            }
            return;
        }
        
        this.isConnecting = true;
        this.isManualClose = false;
        
        console.log('🔗 正在连接 WebSocket...', this.url);
        
        try {
            this.ws = new WebSocket(this.url);
            this.setupEventListeners();
        } catch (error) {
            console.error('❌ WebSocket 连接错误:', error);
            this.handleConnectionError();
        }
    }
    
    setupEventListeners() {
        this.ws.onopen = (event) => {
            console.log('✅ WebSocket 连接成功');
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            
            if (this.onOpen) {
                this.onOpen(event);
            }
        };
        
        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                // 处理心跳响应
                if (data.type === 'pong') {
                    console.log('💓 收到心跳响应');
                    return;
                }
                
                if (this.onMessage) {
                    this.onMessage(data);
                }
            } catch (error) {
                console.error('❌ 解析消息失败:', error, event.data);
            }
        };
        
        this.ws.onclose = (event) => {
            console.log('📴 WebSocket 连接关闭', event.code, event.reason);
            this.isConnecting = false;
            this.stopHeartbeat();
            
            if (this.onClose) {
                this.onClose(event);
            }
            
            // 如果不是手动关闭，尝试重连
            if (!this.isManualClose && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.attemptReconnect();
            }
        };
        
        this.ws.onerror = (error) => {
            console.error('❌ WebSocket 错误:', error);
            
            if (this.onError) {
                this.onError(error);
            }
            
            this.handleConnectionError();
        };
    }
    
    handleConnectionError() {
        this.isConnecting = false;
        this.stopHeartbeat();
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.attemptReconnect();
        }
    }
    
    attemptReconnect() {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // 指数退避
        
        console.log(`🔄 尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})，${delay/1000}秒后重试...`);
        
        if (this.onReconnecting) {
            this.onReconnecting(this.reconnectAttempts, this.maxReconnectAttempts);
        }
        
        setTimeout(() => {
            if (!this.isManualClose) {
                this.connect();
            }
        }, delay);
    }
    
    startHeartbeat() {
        this.stopHeartbeat();
        
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.send({
                    type: 'ping',
                    timestamp: new Date().toISOString()
                });
            }
        }, this.heartbeatDelay);
    }
    
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                const message = typeof data === 'string' ? data : JSON.stringify(data);
                this.ws.send(message);
                return true;
            } catch (error) {
                console.error('❌ 发送消息失败:', error);
                return false;
            }
        } else {
            console.warn('⚠️ WebSocket 未连接，无法发送消息');
            return false;
        }
    }
    
    close() {
        this.isManualClose = true;
        this.stopHeartbeat();
        
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        console.log('👋 WebSocket 连接已手动关闭');
    }
    
    getReadyState() {
        if (!this.ws) return 'CLOSED';
        
        switch (this.ws.readyState) {
            case WebSocket.CONNECTING:
                return 'CONNECTING';
            case WebSocket.OPEN:
                return 'OPEN';
            case WebSocket.CLOSING:
                return 'CLOSING';
            case WebSocket.CLOSED:
                return 'CLOSED';
            default:
                return 'UNKNOWN';
        }
    }
    
    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }
}