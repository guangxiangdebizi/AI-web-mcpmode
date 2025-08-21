// chat.js - 聊天界面逻辑
class ChatApp {
    constructor() {
        this.wsManager = new WebSocketManager();
        this.currentAIMessage = null; // 当前正在接收的AI消息
        this.currentAIContent = ''; // 当前AI消息的累积内容
        this.thinkingFlow = new ThinkingFlow(this); // 思维流管理器
        this.sessionId = null; // 当前会话ID，由后端分配
        
        // DOM 元素
        this.chatMessages = document.getElementById('chatMessages');
        // 缓存欢迎卡片模板，供“Start New Chat”复用
        this.welcomeHTML = (this.chatMessages.querySelector('.welcome-message')?.outerHTML) || '';
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.clearChatBtn = document.getElementById('clearChatBtn');
        this.startNewChatBtn = document.getElementById('startNewChatBtn');
        this.connectionStatus = document.getElementById('connectionStatus');
        this.connectionText = document.getElementById('connectionText');
        this.charCount = document.getElementById('charCount');
        this.loadingOverlay = document.getElementById('loadingOverlay');
        this.modelDropdownBtn = document.getElementById('modelDropdownBtn');
        this.modelDropdown = document.getElementById('modelDropdown');
        this.threadsList = document.getElementById('threadsList');
        this.toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
        this.openSidebarBtn = document.getElementById('openSidebarBtn');
        
        this.init();
    }
    
    async init() {
        try {
            // 首先确保配置已加载
            this.showLoading('正在加载配置...');
            
            if (!window.configManager.isLoaded) {
                await window.configManager.loadConfig();
            }
            
            // 配置加载成功后再初始化其他组件
            this.setupEventListeners();
            // 先加载Model并设置本地选择（确保首连就携带 model）
            await this.loadModelsAndRenderDropdown();
            this.setupWebSocket();
            await this.connectWebSocket();
        } catch (error) {
            console.error('❌ 应用初始化失败:', error);
            this.hideLoading();
            // 配置加载失败时，错误已经在configManager中显示，这里不需要额外处理
        }
    }
    
    setupEventListeners() {
        // 发送按钮点击
        this.sendBtn.addEventListener('click', () => {
            this.sendMessage();
        });
        
        // 输入框事件
        this.messageInput.addEventListener('input', () => {
            this.updateCharCount();
            this.adjustInputHeight();
            this.updateSendButton();
        });
        
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    // Shift + Enter 换行
                    return;
                } else {
                    // Enter 发送
                    e.preventDefault();
                    this.sendMessage();
                }
            }
        });
        
        // 兼容旧按钮（如存在）
        if (this.clearChatBtn) {
            this.clearChatBtn.addEventListener('click', () => this.clearChat());
        }
        // 新建对话：仅清屏，不删除历史
        if (this.startNewChatBtn) {
            this.startNewChatBtn.addEventListener('click', () => {
                // 直接恢复预缓存的欢迎卡片模板
                this.chatMessages.innerHTML = this.welcomeHTML || this.chatMessages.innerHTML;
                this.thinkingFlow.clear();
                this.currentAIMessage = null;
                this.updateSendButton();
                this.scrollToBottom();
            });
        }
        
        // 初始化分享模块
        this.shareModule = new ShareModule(this);
        
        // 页面卸载时关闭连接
        window.addEventListener('beforeunload', () => {
            this.wsManager.close();
        });

        // 侧栏开关
        if (this.toggleSidebarBtn) {
            this.toggleSidebarBtn.addEventListener('click', () => {
                const sidebar = document.getElementById('historySidebar');
                if (!sidebar) return;
                const isOpen = sidebar.classList.toggle('open');
                this.toggleSidebarBtn.textContent = isOpen ? 'Hide' : 'Show';
            });
        }
        if (this.openSidebarBtn) {
            this.openSidebarBtn.addEventListener('click', async () => {
                const sidebar = document.getElementById('historySidebar');
                if (!sidebar) return;
                const isOpen = sidebar.classList.toggle('open');
                // 打开时刷新；关闭时不动
                if (isOpen) {
                    await this.loadThreadsByMsidFromUrl();
                }
                // 可选：按钮文案提示
                this.openSidebarBtn.textContent = isOpen ? '历史记录 (已展开)' : '历史记录';
            });
        }

        // Model下拉
        if (this.modelDropdownBtn) {
            this.modelDropdownBtn.addEventListener('click', () => {
                if (!this.modelDropdown) return;
                this.modelDropdown.style.display = this.modelDropdown.style.display === 'none' || this.modelDropdown.style.display === '' ? 'block' : 'none';
            });
            // 点击页面其他地方关闭
            document.addEventListener('click', (e) => {
                if (!this.modelDropdownBtn.contains(e.target) && !this.modelDropdown.contains(e.target)) {
                    this.modelDropdown.style.display = 'none';
                }
            });
        }
    }
    
    setupWebSocket() {
        // WebSocket 事件回调
        this.wsManager.onOpen = () => {
            this.updateConnectionStatus('online');
            this.hideLoading();
        };
        
        this.wsManager.onMessage = (data) => {
            this.handleWebSocketMessage(data);
        };
        
        this.wsManager.onClose = () => {
            this.updateConnectionStatus('offline');
        };
        
        this.wsManager.onError = () => {
            this.updateConnectionStatus('offline');
            this.showError('WebSocket 连接错误');
        };
        
        this.wsManager.onReconnecting = (attempt, maxAttempts) => {
            this.updateConnectionStatus('connecting');
            this.showStatus(`Reconnecting... (${attempt}/${maxAttempts})`);
        };
    }
    
    async connectWebSocket() {
        this.showLoading('Connecting to server...');
        this.updateConnectionStatus('connecting');
        await this.wsManager.connect();
        // 加载左侧线程列表（如果URL中有msid）
        this.loadThreadsByMsidFromUrl();
    }

    async loadThreadsByMsidFromUrl() {
        try {
            const urlParams = new URLSearchParams(window.location.search || '');
            const msid = urlParams.get('msid');
            const apiUrl = window.configManager.getFullApiUrl(
                msid ? `/api/threads?msid=${encodeURIComponent(msid)}` : `/api/threads`
            );
            const res = await fetch(apiUrl, { cache: 'no-store' });
            const json = await res.json();
            if (!json.success) return;
            this.renderThreads(json.data || []);
        } catch (e) { console.warn('加载线程列表失败', e); }
    }

    renderThreads(threads) {
        if (!this.threadsList) return;
        this.threadsList.innerHTML = '';
        threads.forEach(t => {
            const div = document.createElement('div');
            div.className = 'thread-item';
            const title = (t.first_user_input || 'New conversation').slice(0, 40);
            const meta = `${t.message_count || 0} msgs · ${new Date(t.last_time).toLocaleString()}`;
            div.innerHTML = `<div class="title">${this.escapeHtml(title)}</div><div class="meta"><span>${this.escapeHtml(meta)}</span><span class="delete-icon" title="Delete">🗑️</span></div>`;
            div.addEventListener('click', () => {
                // 切换会话：将 conversation_id 透传到历史 API 拉取详情
                this.loadHistoryForConversation(t.session_id, t.conversation_id);
            });
            // 删除图标点击（阻止冒泡）
            const del = div.querySelector('.delete-icon');
            del.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm('Delete this conversation?')) return;
                try {
                    const apiUrl = window.configManager.getFullApiUrl(`/api/threads?session_id=${encodeURIComponent(t.session_id)}&conversation_id=${encodeURIComponent(t.conversation_id)}`);
                    const res = await fetch(apiUrl, { method: 'DELETE' });
                    const json = await res.json();
                    if (json && json.success) {
                        div.remove();
                    }
                } catch (err) { console.warn('删除会话失败', err); }
            });
            this.threadsList.appendChild(div);
        });
    }

    async loadHistoryForConversation(sessionId, conversationId) {
        try {
            // 清空界面并加载该会话的历史
            this.clearChat();
            this.sessionId = sessionId;
            // 历史回放前隐藏欢迎卡片，避免布局被居中规则影响
            this.hideWelcomeMessage();
            const apiUrl = window.configManager.getFullApiUrl(`/api/history?session_id=${encodeURIComponent(sessionId)}&conversation_id=${encodeURIComponent(conversationId)}`);
            const res = await fetch(apiUrl, { cache: 'no-store' });
            const json = await res.json();
            if (!json.success) return;
            // 把历史记录渲染为与实时一致的结构：用户消息 → 思维链(只读) → AI回复
            (json.data || []).forEach(r => {
                if (r.user_input) this.addUserMessage(r.user_input);

                // 思维链（只读复现）
                this.thinkingFlow.createThinkingFlow();
                const toolsCalled = Array.isArray(r.mcp_tools_called) ? r.mcp_tools_called : [];
                const results = Array.isArray(r.mcp_results) ? r.mcp_results : [];
                if (toolsCalled.length > 0) {
                    this.thinkingFlow.updateThinkingStage(
                        'tools_planned',
                        `Planning to use ${toolsCalled.length} tool(s)`,
                        'Replaying recorded tool operations...',
                        { toolCount: toolsCalled.length }
                    );
                    // 将结果按 tool_id 映射，便于匹配
                    const idToResult = {};
                    results.forEach(x => { if (x && x.tool_id) idToResult[x.tool_id] = x; });
                    toolsCalled.forEach(tc => {
                        const toolId = tc.tool_id || tc.id || tc.name || Math.random().toString(36).slice(2);
                        const toolName = tc.tool_name || (tc.function && tc.function.name) || tc.name || 'tool';
                        const args = tc.tool_args || (tc.function && tc.function.arguments) || {};
                        // 执行占位
                        this.thinkingFlow.addToolToThinking({ tool_id: toolId, tool_name: toolName, tool_args: args });
                        // 完成并展示结果
                        const matched = idToResult[toolId] || {};
                        if (matched && matched.result !== undefined) {
                            this.thinkingFlow.updateToolInThinking({ tool_id: toolId, tool_name: toolName, result: String(matched.result) }, 'completed');
                        } else if (matched && matched.error) {
                            this.thinkingFlow.updateToolInThinking({ tool_id: toolId, tool_name: toolName, error: String(matched.error) }, 'error');
                        } else {
                            this.thinkingFlow.updateToolInThinking({ tool_id: toolId, tool_name: toolName, result: '(no recorded result)' }, 'completed');
                        }
                    });
                    this.thinkingFlow.updateThinkingStage('responding', 'Preparing response', 'Organizing evidence-based conclusions and recommendations...');
                    this.thinkingFlow.completeThinkingFlow('success');
                } else {
                    // 没有工具，直接标记完成
                    this.thinkingFlow.updateThinkingStage('responding', 'Preparing response', 'Organizing evidence-based conclusions and recommendations...');
                    this.thinkingFlow.completeThinkingFlow('success');
                }

                if (r.ai_response) {
                    this.startAIResponse();
                    this.appendAIResponse(r.ai_response);
                    this.endAIResponse();
                }
            });
            this.scrollToBottom();
        } catch (e) { console.warn('加载会话历史失败', e); }
    }

    async loadModelsAndRenderDropdown() {
        try {
            const apiUrl = window.configManager.getFullApiUrl('/api/models');
            const res = await fetch(apiUrl, { cache: 'no-store' });
            const json = await res.json();
            if (!json.success) throw new Error('加载Model列表失败');
            const { models, default: def } = json.data || { models: [], default: 'default' };

            let selected = localStorage.getItem('mcp_selected_model') || def;
            // 如果本地无记录，写入一次，保证首连就有 model
            if (!localStorage.getItem('mcp_selected_model')) {
                localStorage.setItem('mcp_selected_model', selected);
            }
            this.updateModelButtonLabel(models, selected);

            // 渲染菜单
            if (this.modelDropdown) {
                this.modelDropdown.innerHTML = '';
                models.forEach(m => {
                    const item = document.createElement('div');
                    item.className = 'dropdown-item';
                    item.textContent = `${m.label || m.id} (${m.model || ''})`;
                    item.addEventListener('click', async () => {
                        localStorage.setItem('mcp_selected_model', m.id);
                        this.updateModelButtonLabel(models, m.id);
                        this.modelDropdown.style.display = 'none';
                        // 断开并重连以携带新Model参数
                        try { this.wsManager.close(); } catch {}
                        // 强制下次连接重新初始化，以便重建URL并附带 model
                        this.wsManager.isInitialized = false;
                        await this.connectWebSocket();
                    });
                    this.modelDropdown.appendChild(item);
                });
            }
        } catch (e) {
            console.warn('⚠️ 无法加载Model列表:', e);
        }
    }

    updateModelButtonLabel(models, selectedId) {
        try {
            const picked = (models || []).find(m => m.id === selectedId);
            const label = picked ? (picked.label || picked.id) : selectedId;
            if (this.modelDropdownBtn) {
                this.modelDropdownBtn.textContent = `Model：${label} ▾`;
            }
        } catch {}
    }
    
    handleWebSocketMessage(data) {
        console.log('📨 收到消息:', data);
        
        switch (data.type) {
            case 'session_info':
                // 接收会话ID
                this.sessionId = data.session_id;
                console.log('🆔 收到会话ID:', this.sessionId);
                break;
                
            case 'user_msg_received':
                // 用户消息已收到确认
                break;
                
            case 'status':
                // 移除硬编码的status处理，让AI思考内容自然显示
                break;
                
            case 'ai_thinking_start':
                // 开始AI思考流式显示
                this.thinkingFlow.startThinkingContent(data.iteration);
                break;
                
            case 'ai_thinking_chunk':
                // AI思考内容片段
                this.thinkingFlow.appendThinkingContent(data.content, data.iteration);
                break;
                
            case 'ai_thinking_end':
                // 结束AI思考
                this.thinkingFlow.endThinkingContent(data.iteration);
                break;
                
            case 'tool_plan':
                this.thinkingFlow.updateThinkingStage(
                    'tools_planned', 
                    `Planning to use ${data.tool_count} tool(s)`, 
                    'Preparing clinical data operations...',
                    { toolCount: data.tool_count }
                );
                break;
                
            case 'tool_start':
                this.thinkingFlow.addToolToThinking(data);
                break;
                
            case 'tool_end':
                this.thinkingFlow.updateToolInThinking(data, 'completed');
                break;
                
            case 'tool_error':
                this.thinkingFlow.updateToolInThinking(data, 'error');
                break;
                
            case 'ai_response_start':
                this.thinkingFlow.updateThinkingStage('responding', 'Preparing response', 'Organizing evidence-based conclusions and recommendations...');
                
                // 确保思维流可见 - 滚动到思维流位置
                const currentFlow = this.thinkingFlow.getCurrentFlow();
                if (currentFlow) {
                    // 轻微延迟确保DOM更新完成
                    setTimeout(() => {
                        currentFlow.scrollIntoView({ 
                            behavior: 'smooth', 
                            block: 'start',
                            inline: 'nearest'
                        });
                    }, 100);
                }

                this.startAIResponse();
                break;
                
            case 'ai_response_chunk':
                this.appendAIResponse(data.content);
                break;
                
            case 'ai_response_end':
                this.endAIResponse();
                this.thinkingFlow.completeThinkingFlow('success');
                break;
                
            case 'error':
                this.showError(data.content);
                this.thinkingFlow.completeThinkingFlow('error');
                break;
                
            default:
                console.warn('未知消息类型:', data.type);
        }
    }
    
    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message || !this.wsManager.isConnected()) {
            return;
        }

        // 显示用户消息
        this.addUserMessage(message);
        
        // 清空输入框并重置状态
        this.messageInput.value = '';
        this.updateCharCount();
        this.adjustInputHeight();
        this.updateSendButton();

        // 隐藏欢迎消息
        this.hideWelcomeMessage();

        // 创建思维流
        this.thinkingFlow.createThinkingFlow();

        // 发送到服务器
        const success = this.wsManager.send({
            type: 'user_msg',
            content: message
        });
        
        if (!success) {
            this.showError('发送失败，请检查网络连接');
            this.thinkingFlow.completeThinkingFlow('error');
        }
    }
    
    addUserMessage(content) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message user';
        
        // 尝试渲染markdown，如果失败则使用原始文本
        let renderedContent;
        try {
            if (typeof marked !== 'undefined') {
                renderedContent = marked.parse(content);
            } else {
                renderedContent = this.escapeHtml(content);
            }
        } catch (error) {
            console.warn('User message Markdown rendering error:', error);
            renderedContent = this.escapeHtml(content);
        }
        
        messageDiv.innerHTML = `
            <div class="message-bubble">
                ${renderedContent}
            </div>
        `;
        
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
    }
    
    showStatus(content) {
        // 可以在这里显示状态信息，暂时用console.log
        console.log('📊 状态:', content);
    }
    











    
    startAIResponse() {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message ai';
        messageDiv.innerHTML = `
            <div class="message-bubble">
                <span class="ai-cursor">▋</span>
            </div>
        `;
        
        this.chatMessages.appendChild(messageDiv);
        this.currentAIMessage = messageDiv.querySelector('.message-bubble');
        this.currentAIContent = ''; // 重置累积内容
        this.scrollToBottom();
    }
    
    appendAIResponse(content) {
        if (this.currentAIMessage) {
            // 累积内容
            this.currentAIContent += content;
            
            // 实时渲染markdown
            this.renderMarkdownContent();
            
            this.scrollToBottom();
        }
    }
    
    endAIResponse() {
        if (this.currentAIMessage) {
            // 最终渲染markdown（确保所有内容都被处理）
            this.renderMarkdownContent(true);
            
            // 移除光标
            const cursor = this.currentAIMessage.querySelector('.ai-cursor');
            if (cursor) {
                cursor.remove();
            }
            
            this.currentAIMessage = null;
            this.currentAIContent = '';
        }
    }
    
    // 实时markdown渲染方法
    renderMarkdownContent(isFinal = false) {
        if (!this.currentAIMessage || typeof marked === 'undefined') {
            // 如果marked.js未加载，使用原始文本显示
            this.currentAIMessage.innerHTML = this.escapeHtml(this.currentAIContent) + 
                (!isFinal ? '<span class="ai-cursor">▋</span>' : '');
            return;
        }
        
        try {
            let content = this.currentAIContent;
            let renderedContent = '';
            
            if (isFinal) {
                // 最终渲染，直接处理所有内容
                renderedContent = marked.parse(content);
            } else {
                // 实时渲染，需要智能处理不完整的markdown
                renderedContent = this.renderPartialMarkdown(content);
            }
            
            // 更新内容并添加光标
            this.currentAIMessage.innerHTML = renderedContent + 
                (!isFinal ? '<span class="ai-cursor">▋</span>' : '');
                
        } catch (error) {
            console.warn('Markdown渲染错误:', error);
            // 出错时使用原始文本
            this.currentAIMessage.innerHTML = this.escapeHtml(this.currentAIContent) + 
                (!isFinal ? '<span class="ai-cursor">▋</span>' : '');
        }
    }
    
    // 渲染部分markdown内容（处理不完整的语法）
    renderPartialMarkdown(content) {
        // 检测可能不完整的markdown模式
        const patterns = [
            { regex: /```[\s\S]*?```/g, type: 'codeblock' },  // 代码块
            { regex: /`[^`\n]*`/g, type: 'code' },            // 行内代码
            { regex: /\*\*[^*\n]*\*\*/g, type: 'bold' },      // 粗体
            { regex: /\*[^*\n]*\*/g, type: 'italic' },        // 斜体
            { regex: /^#{1,6}\s+.*/gm, type: 'heading' },     // 标题
            { regex: /^\*.+$/gm, type: 'list' },              // 列表
            { regex: /^\d+\..+$/gm, type: 'orderedlist' },    // 有序列表
            { regex: /^>.+$/gm, type: 'quote' }               // 引用
        ];
        
        let processedContent = content;
        let lastCompletePos = 0;
        
        // 找到最后一个完整的markdown元素位置
        for (let pattern of patterns) {
            const matches = [...content.matchAll(pattern.regex)];
            for (let match of matches) {
                const endPos = match.index + match[0].length;
                if (this.isCompleteMarkdown(match[0], pattern.type)) {
                    lastCompletePos = Math.max(lastCompletePos, endPos);
                }
            }
        }
        
        if (lastCompletePos > 0) {
            // 分割内容：完整部分用markdown渲染，不完整部分用原始文本
            const completeContent = content.substring(0, lastCompletePos);
            const incompleteContent = content.substring(lastCompletePos);
            
            const renderedComplete = marked.parse(completeContent);
            const escapedIncomplete = this.escapeHtml(incompleteContent);
            
            return renderedComplete + escapedIncomplete;
        } else {
            // 没有完整的markdown，使用原始文本
            return this.escapeHtml(content);
        }
    }
    
    // 检查markdown元素是否完整
    isCompleteMarkdown(text, type) {
        switch (type) {
            case 'codeblock':
                return text.startsWith('```') && text.endsWith('```') && text.length > 6;
            case 'code':
                return text.startsWith('`') && text.endsWith('`') && text.length > 2;
            case 'bold':
                return text.startsWith('**') && text.endsWith('**') && text.length > 4;
            case 'italic':
                return text.startsWith('*') && text.endsWith('*') && text.length > 2 && !text.startsWith('**');
            case 'heading':
                return text.match(/^#{1,6}\s+.+$/);
            case 'list':
                return text.match(/^\*\s+.+$/);
            case 'orderedlist':
                return text.match(/^\d+\.\s+.+$/);
            case 'quote':
                return text.match(/^>\s*.+$/);
            default:
                return true;
        }
    }
    
    showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'message ai';
        errorDiv.innerHTML = `
            <div class="message-bubble" style="background: rgba(245, 101, 101, 0.1); border-color: rgba(245, 101, 101, 0.3); color: #e53e3e;">
                ❌ ${this.escapeHtml(message)}
            </div>
        `;
        
        this.chatMessages.appendChild(errorDiv);
        this.scrollToBottom();
    }
    
    clearChat() {
        // 清空消息区域，保留欢迎消息
        const welcomeMessage = this.chatMessages.querySelector('.welcome-message');
        this.chatMessages.innerHTML = '';
        
        if (welcomeMessage) {
            this.chatMessages.appendChild(welcomeMessage);
            welcomeMessage.style.display = 'block';
        }
        
        // 清理状态
        this.currentAIMessage = null;
        this.thinkingFlow.clear(); // 清理思维流状态
        
        // 调用API清空后端历史
        try {
            // 确保配置已加载
            if (!window.configManager.isLoaded) {
                console.warn('⚠️ 配置未加载，无法清空服务器历史');
                return;
            }
            
            // 构建API URL，如果有会话ID则传递
            let apiUrl = window.configManager.getFullApiUrl('/api/history');
            if (this.sessionId) {
                apiUrl += `?session_id=${encodeURIComponent(this.sessionId)}`;
                console.log('🗑️ 清空当前会话历史:', this.sessionId);
            } else {
                console.log('🗑️ 清空所有历史（无会话ID）');
            }
            
            fetch(apiUrl, {
                method: 'DELETE'
            }).catch(error => {
                console.warn('清空服务器历史失败:', error);
            });
        } catch (error) {
            console.error('❌ 无法获取API URL，清空历史失败:', error);
        }
    }
    
    hideWelcomeMessage() {
        const welcomeMessage = this.chatMessages.querySelector('.welcome-message');
        if (welcomeMessage) {
            welcomeMessage.style.display = 'none';
        }
    }
    
    updateConnectionStatus(status) {
        this.connectionStatus.className = `status-dot ${status}`;
        
        switch (status) {
            case 'online':
                this.connectionText.textContent = '在线';
                break;
            case 'offline':
                this.connectionText.textContent = '离线';
                break;
            case 'connecting':
                this.connectionText.textContent = '连接中';
                break;
        }
    }
    
    updateCharCount() {
        const count = this.messageInput.value.length;
        this.charCount.textContent = count;
        
        if (count > 1800) {
            this.charCount.style.color = '#e53e3e';
        } else if (count > 1500) {
            this.charCount.style.color = '#ed8936';
        } else {
            this.charCount.style.color = '#a0aec0';
        }
    }
    
    adjustInputHeight() {
        // 保存滚动位置
        const scrollTop = this.messageInput.scrollTop;
        
        // 重置高度
        this.messageInput.style.height = 'auto';
        
        // 设置新高度
        const newHeight = Math.min(this.messageInput.scrollHeight, 150);
        this.messageInput.style.height = newHeight + 'px';
        
        // 恢复滚动位置
        this.messageInput.scrollTop = scrollTop;
        
        // 如果内容超出了可视区域，滚动到底部
        if (this.messageInput.scrollHeight > newHeight) {
            this.messageInput.scrollTop = this.messageInput.scrollHeight;
        }
    }
    
    updateSendButton() {
        const hasText = this.messageInput.value.trim().length > 0;
        const isConnected = this.wsManager.isConnected();
        
        this.sendBtn.disabled = !hasText || !isConnected;
    }
    
    scrollToBottom() {
        // 使用requestAnimationFrame确保DOM更新完成后再滚动
        requestAnimationFrame(() => {
            this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        });
    }
    
    showLoading(text = 'Loading...') {
        this.loadingOverlay.style.display = 'flex';
        this.loadingOverlay.querySelector('div').textContent = text;
    }
    
    hideLoading() {
        this.loadingOverlay.style.display = 'none';
    }
    
    escapeHtml(text) {
        if (text === null || text === undefined) {
            return '';
        }
        return text.toString()
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
    }
}
// 实例化并初始化
const chatApp = new ChatApp();