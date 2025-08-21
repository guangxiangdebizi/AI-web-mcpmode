# main.py
"""
FastAPI 后端主文件
提供WebSocket聊天接口和REST API
"""

import json
import asyncio
import uuid
from typing import List, Dict, Any
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
import os
from dotenv import load_dotenv, find_dotenv
import uvicorn

from mcp_agent import WebMCPAgent
from database import ChatDatabase

# 全局变量
mcp_agent = None
chat_db = None  # SQLite数据库实例
active_connections: List[WebSocket] = []

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    global mcp_agent, chat_db
    
    # 启动时初始化
    print("🚀 启动 MCP Web 智能助手...")
    
    # 初始化数据库
    chat_db = ChatDatabase()
    db_success = await chat_db.initialize()
    if not db_success:
        print("❌ 数据库初始化失败")
        raise Exception("数据库初始化失败")
    
    # 初始化MCP智能体
    mcp_agent = WebMCPAgent()
    mcp_success = await mcp_agent.initialize()
    
    if not mcp_success:
        print("❌ MCP智能体初始化失败")
        raise Exception("MCP智能体初始化失败")
    
    print("✅ MCP Web 智能助手启动成功")
    
    yield
    
    # 关闭时清理资源
    if mcp_agent:
        await mcp_agent.close()
    if chat_db:
        await chat_db.close()
    print("👋 MCP Web 智能助手已关闭")

# 创建FastAPI应用
# 预加载 .env（不覆盖系统变量）
try:
    load_dotenv(find_dotenv(), override=False)
except Exception:
    pass

app = FastAPI(
    title="MCP Web智能助手",
    description="基于MCP的智能助手Web版",
    version="1.0.0",
    lifespan=lifespan
)

# 配置CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境应该限制具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



# ─────────── WebSocket 接口 ───────────

class ConnectionManager:
    """WebSocket连接管理器"""
    
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.connection_sessions: Dict[WebSocket, str] = {}  # 连接到会话ID的映射
    
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        # 为每个连接生成唯一的会话ID
        session_id = str(uuid.uuid4())
        self.active_connections.append(websocket)
        self.connection_sessions[websocket] = session_id
        print(f"📱 新连接建立，会话ID: {session_id}，当前连接数: {len(self.active_connections)}")
        
        # 向前端发送会话ID
        await self.send_personal_message({
            "type": "session_info",
            "session_id": session_id
        }, websocket)
        
        return session_id
    
    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        if websocket in self.connection_sessions:
            session_id = self.connection_sessions[websocket]
            del self.connection_sessions[websocket]
            print(f"📱 连接断开，会话ID: {session_id}，当前连接数: {len(self.active_connections)}")
            # 清理会话上下文，避免日志中积累大量历史会话
            try:
                if mcp_agent and hasattr(mcp_agent, 'session_contexts'):
                    mcp_agent.session_contexts.pop(session_id, None)
            except Exception:
                pass
    
    def get_session_id(self, websocket: WebSocket) -> str:
        """获取WebSocket连接对应的会话ID"""
        return self.connection_sessions.get(websocket, "default")
    
    async def send_personal_message(self, message: dict, websocket: WebSocket):
        try:
            await websocket.send_text(json.dumps(message, ensure_ascii=False))
        except Exception as e:
            print(f"❌ 发送消息失败: {e}")

manager = ConnectionManager()

@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    """WebSocket聊天接口"""
    session_id = await manager.connect(websocket)
    # 从连接查询参数中读取 msid 与 model 并保存到会话上下文（后端隐藏使用，不回传给前端）
    try:
        print(f"🔍 WebSocket 查询参数: {dict(websocket.query_params)}")
        msid_param = websocket.query_params.get("msid")
        model_param = websocket.query_params.get("model")
        print(f"🔍 提取的 msid 参数: {msid_param}")
        print(f"🔍 提取的 model 参数: {model_param}")
        if msid_param is not None and msid_param != "":
            try:
                msid_value = int(msid_param)
                if not hasattr(mcp_agent, 'session_contexts'):
                    mcp_agent.session_contexts = {}
                mcp_agent.session_contexts[session_id] = {"msid": msid_value}
                print(f"🔐 已为会话 {session_id} 记录 msid={msid_value}")
                print(f"🔍 当前所有会话上下文: {mcp_agent.session_contexts}")
            except Exception as e:
                print(f"⚠️ 解析 msid 失败: {e}")
                # 非法 msid 忽略
                if not hasattr(mcp_agent, 'session_contexts'):
                    mcp_agent.session_contexts = {}
                mcp_agent.session_contexts[session_id] = {}
        else:
            print(f"⚠️ msid 参数为空或不存在")
            if not hasattr(mcp_agent, 'session_contexts'):
                mcp_agent.session_contexts = {}
            mcp_agent.session_contexts[session_id] = {}

        # 记录模型档位（如果提供）
        try:
            if model_param is not None and model_param != "":
                if not hasattr(mcp_agent, 'session_contexts'):
                    mcp_agent.session_contexts = {}
                session_ctx = mcp_agent.session_contexts.get(session_id, {})
                session_ctx["model"] = str(model_param)
                mcp_agent.session_contexts[session_id] = session_ctx
                print(f"🔐 已为会话 {session_id} 记录 model={model_param}")
        except Exception as e:
            print(f"⚠️ 记录 model 失败: {e}")
    except Exception as _e:
        print(f"❌ 处理 msid 参数异常: {_e}")
        if not hasattr(mcp_agent, 'session_contexts'):
            mcp_agent.session_contexts = {}
        mcp_agent.session_contexts[session_id] = {}
    
    try:
        while True:
            # 接收客户端消息
            data = await websocket.receive_text()
            
            try:
                message = json.loads(data)
                
                if message.get("type") == "user_msg":
                    user_input = message.get("content", "").strip()
                    
                    if not user_input:
                        await manager.send_personal_message({
                            "type": "error",
                            "content": "用户输入不能为空"
                        }, websocket)
                        continue
                    
                    print(f"📨 收到用户消息: {user_input[:50]}...")
                    
                    # 确认收到用户消息
                    await manager.send_personal_message({
                        "type": "user_msg_received",
                        "content": user_input
                    }, websocket)
                    
                    # 收集对话数据
                    conversation_data = {
                        "user_input": user_input,
                        "mcp_tools_called": [],
                        "mcp_results": [],
                        "ai_response_parts": []
                    }
                    
                    # 获取当前连接的聊天历史
                    current_session_id = manager.get_session_id(websocket)
                    history = await chat_db.get_chat_history(session_id=current_session_id, limit=10) # 限制最近10条

                    # 流式处理并推送AI响应
                    try:
                        async for response_chunk in mcp_agent.chat_stream(user_input, history=history, session_id=current_session_id):
                            # 转发给客户端
                            await manager.send_personal_message(response_chunk, websocket)
                            
                            # 收集不同类型的响应数据
                            chunk_type = response_chunk.get("type")
                            
                            if chunk_type == "tool_start":
                                # 记录工具调用开始
                                tool_call = {
                                    "tool_id": response_chunk.get("tool_id"),
                                    "tool_name": response_chunk.get("tool_name"),
                                    "tool_args": response_chunk.get("tool_args"),
                                    "progress": response_chunk.get("progress")
                                }
                                conversation_data["mcp_tools_called"].append(tool_call)
                            
                            elif chunk_type == "tool_end":
                                # 记录工具执行结果
                                tool_result = {
                                    "tool_id": response_chunk.get("tool_id"),
                                    "tool_name": response_chunk.get("tool_name"),
                                    "result": response_chunk.get("result"),
                                    "success": True
                                }
                                conversation_data["mcp_results"].append(tool_result)
                            
                            elif chunk_type == "tool_error":
                                # 记录工具执行错误
                                tool_error = {
                                    "tool_id": response_chunk.get("tool_id"),
                                    "error": response_chunk.get("error"),
                                    "success": False
                                }
                                conversation_data["mcp_results"].append(tool_error)
                            
                            elif chunk_type == "ai_response_chunk":
                                # 收集AI回复内容片段
                                conversation_data["ai_response_parts"].append(
                                    response_chunk.get("content", "")
                                )
                            
                            elif chunk_type == "ai_thinking_chunk":
                                # 收集AI思考内容片段到回复中
                                conversation_data["ai_response_parts"].append(
                                    response_chunk.get("content", "")
                                )
                            
                            elif chunk_type == "error":
                                # 记录错误信息
                                print(f"❌ MCP处理错误: {response_chunk.get('content')}")
                                # 即使出错也要保存对话记录
                                break
                        
                        # 组装完整的AI回复
                        ai_response = "".join(conversation_data["ai_response_parts"])
                        
                        # 如果没有AI回复但有错误，添加错误信息
                        if not ai_response and conversation_data["mcp_results"]:
                            error_results = [r for r in conversation_data["mcp_results"] if not r.get("success", True)]
                            if error_results:
                                ai_response = f"处理过程中遇到错误：\n" + "\n".join([r.get("error", "未知错误") for r in error_results])
                        
                        print(f"💾 准备保存对话记录，AI回复长度: {len(ai_response)}")
                        
                    except Exception as e:
                        print(f"❌ MCP流式处理异常: {e}")
                        import traceback
                        traceback.print_exc()
                        
                        # 即使异常也要保存对话记录
                        ai_response = f"处理请求时出错: {str(e)}"
                        conversation_data["ai_response_parts"] = [ai_response]
                    
                    # 保存完整对话到数据库
                    if chat_db:
                        try:
                            success = await chat_db.save_conversation(
                                user_input=conversation_data["user_input"],
                                mcp_tools_called=conversation_data["mcp_tools_called"],
                                mcp_results=conversation_data["mcp_results"],
                                ai_response=ai_response,
                                session_id=current_session_id,
                                msid=mcp_agent.session_contexts.get(current_session_id, {}).get("msid") if hasattr(mcp_agent, 'session_contexts') else None
                            )
                            if success:
                                print(f"✅ 对话记录保存成功")
                            else:
                                print(f"❌ 对话记录保存失败")
                        except Exception as e:
                            print(f"❌ 保存对话记录异常: {e}")
                
                elif message.get("type") == "ping":
                    # 心跳响应
                    await manager.send_personal_message({
                        "type": "pong",
                        "timestamp": datetime.now().isoformat()
                    }, websocket)
                
                else:
                    await manager.send_personal_message({
                        "type": "error",
                        "content": f"未知消息类型: {message.get('type')}"
                    }, websocket)
                    
            except json.JSONDecodeError:
                await manager.send_personal_message({
                    "type": "error",
                    "content": "消息格式错误，请发送有效的JSON"
                }, websocket)
            except Exception as e:
                print(f"❌ WebSocket消息处理异常: {e}")
                import traceback
                traceback.print_exc()
                await manager.send_personal_message({
                    "type": "error",
                    "content": f"处理消息时出错: {str(e)}"
                }, websocket)
                
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"❌ WebSocket错误: {e}")
        manager.disconnect(websocket)

# ─────────── REST API 接口 ───────────

@app.get("/")
async def root():
    """根路径重定向到前端"""
    return {"message": "MCP Web智能助手API", "version": "1.0.0"}

@app.get("/api/tools")
async def get_tools():
    """获取可用工具列表"""
    if not mcp_agent:
        raise HTTPException(status_code=503, detail="MCP智能体未初始化")
    
    try:
        tools_info = mcp_agent.get_tools_info()
        return {
            "success": True,
            "data": tools_info
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取工具列表失败: {str(e)}")

@app.get("/api/models")
async def get_models():
    """获取可选的大模型档位列表（用于前端下拉选择）。"""
    if not mcp_agent:
        raise HTTPException(status_code=503, detail="MCP智能体未初始化")
    try:
        return {"success": True, "data": mcp_agent.get_models_info()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取模型列表失败: {str(e)}")

@app.get("/api/history")
async def get_history(limit: int = 50, session_id: str = "default", conversation_id: int = None):
    """获取聊天历史"""
    if not chat_db:
        raise HTTPException(status_code=503, detail="数据库未初始化")
    
    try:
        records = await chat_db.get_chat_history(
            session_id=session_id, 
            limit=limit,
            conversation_id=conversation_id
        )
        
        # 获取统计信息
        stats = await chat_db.get_stats()
        
        return {
            "success": True,
            "data": records,
            "total": stats.get("total_records", 0),
            "returned": len(records),
            "session_id": session_id,
            "conversation_id": conversation_id
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取历史记录失败: {str(e)}")

@app.get("/api/threads")
async def get_threads(msid: int = None, limit: int = 100):
    """获取对话线程列表：如果提供 msid 则按 msid 过滤，否则返回所有线程（左侧侧栏用）。"""
    if not chat_db:
        raise HTTPException(status_code=503, detail="数据库未初始化")
    try:
        if msid is not None:
            threads = await chat_db.get_threads_by_msid(msid=msid, limit=limit)
        else:
            threads = await chat_db.get_threads_all(limit=limit)
        return {"success": True, "data": threads}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取线程列表失败: {str(e)}")

@app.delete("/api/history")
async def clear_history(session_id: str = None):
    """清空聊天历史"""
    if not chat_db:
        raise HTTPException(status_code=503, detail="数据库未初始化")
    
    try:
        # 如果没有提供session_id，则清空所有历史（保持向后兼容）
        if session_id:
            success = await chat_db.clear_history(session_id=session_id)
            message = f"会话 {session_id} 的聊天历史已清空"
        else:
            success = await chat_db.clear_history()
            message = "所有聊天历史已清空"
        
        if success:
            return {"success": True, "message": message}
        else:
            raise HTTPException(status_code=500, detail="清空历史记录失败")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"清空历史记录失败: {str(e)}")

@app.delete("/api/threads")
async def delete_thread(session_id: str, conversation_id: int):
    """删除某个对话线程"""
    if not chat_db:
        raise HTTPException(status_code=503, detail="数据库未初始化")
    try:
        ok = await chat_db.delete_conversation(session_id=session_id, conversation_id=conversation_id)
        if ok:
            return {"success": True}
        raise HTTPException(status_code=500, detail="删除对话线程失败")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除对话线程失败: {str(e)}")

@app.get("/api/status")
async def get_status():
    """获取系统状态"""
    # 获取数据库统计信息
    db_stats = {}
    if chat_db:
        try:
            db_stats = await chat_db.get_stats()
        except Exception as e:
            print(f"⚠️ 获取数据库统计失败: {e}")
    
    return {
        "success": True,
        "data": {
            "agent_initialized": mcp_agent is not None,
            "database_initialized": chat_db is not None,
            "tools_count": len(mcp_agent.tools) if mcp_agent else 0,
            "active_connections": len(manager.active_connections),
            "chat_records_count": db_stats.get("total_records", 0),
            "chat_sessions_count": db_stats.get("total_sessions", 0),
            "chat_conversations_count": db_stats.get("total_conversations", 0),
            "latest_record": db_stats.get("latest_record"),
            "database_path": db_stats.get("database_path"),
            "timestamp": datetime.now().isoformat()
        }
    }

@app.get("/api/database/stats")
async def get_database_stats():
    """获取数据库详细统计信息"""
    if not chat_db:
        raise HTTPException(status_code=503, detail="数据库未初始化")
    
    try:
        stats = await chat_db.get_stats()
        return {
            "success": True,
            "data": stats
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取数据库统计失败: {str(e)}")

@app.get("/api/share/{session_id}")
async def get_shared_chat(session_id: str, limit: int = 100):
    """获取分享的聊天记录（只读）"""
    if not chat_db:
        raise HTTPException(status_code=503, detail="数据库未初始化")
    
    try:
        # 获取指定会话的聊天历史
        records = await chat_db.get_chat_history(
            session_id=session_id, 
            limit=limit
        )
        
        if not records:
            raise HTTPException(status_code=404, detail="未找到该会话的聊天记录")
        
        # 获取会话统计信息
        stats = await chat_db.get_stats()
        
        return {
            "success": True,
            "data": records,
            "session_id": session_id,
            "total_records": len(records),
            "shared_at": datetime.now().isoformat(),
            "readonly": True
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取分享聊天记录失败: {str(e)}")

# ─────────── 静态文件服务（可选） ───────────

# 如果要让FastAPI直接服务前端文件，取消下面的注释
# app.mount("/static", StaticFiles(directory="../frontend"), name="static")

if __name__ == "__main__":
    # 开发环境启动
    # 端口可通过环境变量 BACKEND_PORT 覆盖，默认 8003，与前端配置一致
    try:
        port = int(os.getenv("BACKEND_PORT", "8003"))
    except Exception:
        port = 8003
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=True,
        log_level="info"
    )