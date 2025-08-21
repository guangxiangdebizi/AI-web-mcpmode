# database.py
"""
SQLite数据库管理
存储聊天记录：用户问题、MCP工具返回内容、AI回复
"""

import os
import json
import aiosqlite
from typing import List, Dict, Any, Optional
from datetime import datetime
from pathlib import Path


class ChatDatabase:
    """聊天记录数据库管理类"""
    
    def __init__(self, db_path: str = "chat_history.db"):
        """初始化数据库连接
        
        Args:
            db_path: 数据库文件路径，默认为当前目录下的chat_history.db
        """
        # 确保使用绝对路径
        if not os.path.isabs(db_path):
            db_path = Path(__file__).parent / db_path
        
        self.db_path = str(db_path)
        print(f"📁 数据库路径: {self.db_path}")
    
    async def initialize(self):
        """初始化数据库表结构"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                # 创建聊天会话表
                await db.execute("""
                    CREATE TABLE IF NOT EXISTS chat_sessions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        session_id TEXT NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                
                # 创建聊天记录表
                await db.execute("""
                    CREATE TABLE IF NOT EXISTS chat_records (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        session_id TEXT DEFAULT 'default',
                        conversation_id INTEGER,
                        
                        -- 用户输入
                        user_input TEXT,
                        user_timestamp TIMESTAMP,
                        
                        -- MCP工具相关
                        mcp_tools_called TEXT,  -- JSON格式存储调用的工具信息
                        mcp_results TEXT,       -- JSON格式存储工具返回结果
                        
                        -- AI回复
                        ai_response TEXT,
                        ai_timestamp TIMESTAMP,
                        
                        -- 元数据
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        
                        FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id)
                    )
                """)
                # 创建索引以提高查询性能
                await db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_chat_records_session 
                    ON chat_records(session_id)
                """)
                # msid index removed
                
                await db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_chat_records_conversation 
                    ON chat_records(conversation_id)
                """)
                
                await db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_chat_records_created 
                    ON chat_records(created_at)
                """)
                
                await db.commit()
                print("✅ 数据库表结构初始化完成")
                return True
                
        except Exception as e:
            print(f"❌ 数据库初始化失败: {e}")
            return False
    
    async def start_conversation(self, session_id: str = "default") -> int:
        """开始新的对话，返回conversation_id"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                # 确保session存在
                await db.execute("""
                    INSERT INTO chat_sessions (session_id)
                    SELECT ?
                    WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE session_id = ?)
                """, (session_id, session_id))
                
                # 获取下一个conversation_id
                cursor = await db.execute("""
                    SELECT COALESCE(MAX(conversation_id), 0) + 1 
                    FROM chat_records WHERE session_id = ?
                """, (session_id,))
                conversation_id = (await cursor.fetchone())[0]
                
                await db.commit()
                return conversation_id
                
        except Exception as e:
            print(f"❌ 开始对话失败: {e}")
            return 1  # 默认返回1
    
    async def save_conversation(
        self, 
        user_input: str,
        mcp_tools_called: List[Dict[str, Any]] = None,
        mcp_results: List[Dict[str, Any]] = None,
        ai_response: str = "",
        session_id: str = "default",
        conversation_id: int = None
    ) -> bool:
        """保存完整的对话记录
        
        Args:
            user_input: 用户输入的问题
            mcp_tools_called: 调用的MCP工具列表
            mcp_results: MCP工具返回的结果列表
            ai_response: AI的回复内容
            session_id: 会话ID
            conversation_id: 对话ID，如果为None则自动生成
        """
        try:
            async with aiosqlite.connect(self.db_path) as db:
                if conversation_id is None:
                    conversation_id = await self.start_conversation(session_id)
                
                # 将工具调用和结果转换为JSON
                mcp_tools_json = json.dumps(mcp_tools_called or [], ensure_ascii=False)
                mcp_results_json = json.dumps(mcp_results or [], ensure_ascii=False)
                
                await db.execute("""
                    INSERT INTO chat_records (
                        session_id, conversation_id,
                        user_input, user_timestamp,
                        mcp_tools_called, mcp_results,
                        ai_response, ai_timestamp
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    session_id, conversation_id,
                    user_input, datetime.now().isoformat(),
                    mcp_tools_json, mcp_results_json,
                    ai_response, datetime.now().isoformat()
                ))
                
                await db.commit()
                print(f"💾 对话记录已保存 (session={session_id}, conversation={conversation_id})")
                return True
                
        except Exception as e:
            print(f"❌ 保存对话记录失败: {e}")
            return False

    async def get_threads_all(self, limit: int = 100) -> List[Dict[str, Any]]:
        """返回所有对话线程列表（按 session_id + conversation_id 分组）。"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute(
                    """
                    SELECT session_id, conversation_id,
                           MIN(created_at) AS first_time,
                           MAX(created_at) AS last_time,
                           COUNT(*) AS message_count,
                           COALESCE(
                               (SELECT user_input FROM chat_records cr2 
                                WHERE cr2.session_id = cr.session_id AND cr2.conversation_id = cr.conversation_id 
                                ORDER BY cr2.created_at ASC LIMIT 1),
                               ''
                           ) AS first_user_input
                    FROM chat_records cr
                    GROUP BY session_id, conversation_id
                    ORDER BY last_time DESC
                    LIMIT ?
                    """,
                    (limit,),
                )
                rows = await cursor.fetchall()
                columns = [desc[0] for desc in cursor.description]
                return [dict(zip(columns, row)) for row in rows]
        except Exception as e:
            print(f"❌ 获取所有线程列表失败: {e}")
            return []
    
    
    async def get_chat_history(
        self, 
        session_id: str = "default", 
        limit: int = 50,
        conversation_id: int = None
    ) -> List[Dict[str, Any]]:
        """获取聊天历史记录
        
        Args:
            session_id: 会话ID
            limit: 返回记录数量限制
            conversation_id: 特定对话ID，如果指定则只返回该对话
        """
        try:
            async with aiosqlite.connect(self.db_path) as db:
                if conversation_id is not None:
                    # 获取特定对话
                    cursor = await db.execute("""
                        SELECT * FROM chat_records 
                        WHERE session_id = ? AND conversation_id = ?
                        ORDER BY created_at ASC
                    """, (session_id, conversation_id))
                else:
                    # 获取最近的对话记录
                    cursor = await db.execute("""
                        SELECT * FROM (
                            SELECT * FROM chat_records 
                            WHERE session_id = ?
                            ORDER BY created_at DESC 
                            LIMIT ?
                        ) ORDER BY created_at ASC
                    """, (session_id, limit))
                
                rows = await cursor.fetchall()
                columns = [desc[0] for desc in cursor.description]
                
                records = []
                for row in rows:
                    record = dict(zip(columns, row))
                    
                    # 解析JSON字段
                    try:
                        record['mcp_tools_called'] = json.loads(record['mcp_tools_called'] or '[]')
                        record['mcp_results'] = json.loads(record['mcp_results'] or '[]')
                    except json.JSONDecodeError:
                        record['mcp_tools_called'] = []
                        record['mcp_results'] = []
                    
                    records.append(record)
                
                # 如果不是特定对话，需要反转顺序（最新的在前面）
                if conversation_id is None:
                    records.reverse()
                
                return records
                
        except Exception as e:
            print(f"❌ 获取聊天历史失败: {e}")
            return []
    
    async def clear_history(self, session_id: str = "default") -> bool:
        """清空指定会话的聊天历史"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute("""
                    DELETE FROM chat_records WHERE session_id = ?
                """, (session_id,))
                
                await db.execute("""
                    DELETE FROM chat_sessions WHERE session_id = ?
                """, (session_id,))
                
                await db.commit()
                print(f"🗑️ 已清空会话 {session_id} 的聊天历史")
                return True
                
        except Exception as e:
            print(f"❌ 清空聊天历史失败: {e}")
            return False

    async def delete_conversation(self, session_id: str, conversation_id: int) -> bool:
        """删除指定会话中的某个对话线程"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute(
                    "DELETE FROM chat_records WHERE session_id = ? AND conversation_id = ?",
                    (session_id, conversation_id),
                )
                await db.commit()
                return True
        except Exception as e:
            print(f"❌ 删除对话线程失败: {e}")
            return False
    
    async def get_stats(self) -> Dict[str, Any]:
        """获取数据库统计信息"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                # 总记录数
                cursor = await db.execute("SELECT COUNT(*) FROM chat_records")
                total_records = (await cursor.fetchone())[0]
                
                # 会话数
                cursor = await db.execute("SELECT COUNT(DISTINCT session_id) FROM chat_records")
                total_sessions = (await cursor.fetchone())[0]
                
                # 对话数
                cursor = await db.execute("SELECT COUNT(DISTINCT conversation_id) FROM chat_records")
                total_conversations = (await cursor.fetchone())[0]
                
                # 最近记录时间
                cursor = await db.execute("SELECT MAX(created_at) FROM chat_records")
                latest_record = (await cursor.fetchone())[0]
                
                return {
                    "total_records": total_records,
                    "total_sessions": total_sessions,
                    "total_conversations": total_conversations,
                    "latest_record": latest_record,
                    "database_path": self.db_path
                }
                
        except Exception as e:
            print(f"❌ 获取统计信息失败: {e}")
            return {}
    
    async def close(self):
        """关闭数据库连接（在aiosqlite中不需要显式关闭）"""
        pass