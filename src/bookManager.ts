import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

type StatusBarPosition = 'left' | 'right';
type StatusBarOrder = '1' | '2' | '3' | '4' | '5' | '6';

interface DailyStats {
	[date: string]: number;  // 格式: "YYYY-MM-DD": 字数
}

export class BookManager {
	private static panel: vscode.WebviewPanel | undefined;

	static show(context: vscode.ExtensionContext) {
		if (this.panel) {
			this.panel.reveal();
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'bookManager',
			'阅读管理',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);

		this.panel.webview.html = this.getWebviewContent();
		
		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});

		// 处理来自 WebView 的消息
		this.handleWebviewMessage(this.panel, context);
	}

	private static getWebviewContent(): string {
		const config = vscode.workspace.getConfiguration('zloveread');
		const bookPath = config.get('bookPath') as string;
		const currentBook = config.get('currentBook') as string;
		const lineLength = config.get('lineLength', 15);
		const showProgress = config.get('showProgress', true) as boolean;
		const statusBarPosition = config.get('statusBarPosition', 'left') as StatusBarPosition;
		const statusBarPriority = config.get('statusBarPriority', 100);

		return /* html */`
			<!DOCTYPE html>
			<html>
			<head>
				<meta charset="UTF-8">
				<style>
					body { 
						padding: 20px;
						font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
					}
					.section { 
						margin-bottom: 30px;
						background: var(--vscode-editor-background);
						padding: 20px;
						border-radius: 6px;
					}
					.section h2 {
						margin-top: 0;
						color: var(--vscode-editor-foreground);
						font-size: 1.2em;
						margin-bottom: 20px;
					}
					.config-item {
						margin: 15px 0;
						display: flex;
						align-items: center;
					}
					.config-item label {
						width: 120px;
						margin-right: 10px;
						color: var(--vscode-editor-foreground);
					}
					.config-item input[type="text"],
					.config-item input[type="number"] {
						flex: 1;
						padding: 5px 10px;
						border: 1px solid var(--vscode-input-border);
						background: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
						border-radius: 4px;
					}
					.config-item select {
						flex: 1;
						padding: 5px 10px;
						border: 1px solid var(--vscode-dropdown-border);
						background: var(--vscode-dropdown-background);
						color: var(--vscode-dropdown-foreground);
						border-radius: 4px;
					}
					.config-item button {
						margin-left: 10px;
						padding: 5px 10px;
						background: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						border-radius: 4px;
						cursor: pointer;
					}
					.config-item button:hover {
						background: var(--vscode-button-hoverBackground);
					}
					.book-item {
						display: flex;
						justify-content: space-between;
						align-items: center;
						padding: 15px;
						margin-bottom: 10px;
						background: var(--vscode-editor-background);
						border: 1px solid var(--vscode-input-border);
						border-radius: 4px;
					}
					.book-info { 
						flex: 1;
						color: var(--vscode-editor-foreground);
					}
					.book-info div {
						margin: 3px 0;
					}
					.remove-btn {
						color: var(--vscode-errorForeground);
						cursor: pointer;
						padding: 5px 10px;
					}
					.remove-btn:hover {
						text-decoration: underline;
					}
					.stats-item {
						padding: 15px;
						background: var(--vscode-editor-background);
						border: 1px solid var(--vscode-input-border);
						border-radius: 4px;
					}
					.stats-item div {
						margin: 5px 0;
						color: var(--vscode-editor-foreground);
					}
				</style>
			</head>
			<body>
				<div class="section">
					<h2>配置设置</h2>
					<div class="config-item">
						<label>电子书目录:</label>
						<input type="text" value="${bookPath || ''}" readonly>
						<button onclick="selectBookPath()">选择目录</button>
						<button onclick="resetBookPath()" style="background: var(--vscode-errorForeground);">重置</button>
					</div>
					<div class="config-item">
						<label>当前阅读:</label>
						<input type="text" value="${currentBook || '未选择'}" readonly>
						<button onclick="selectBook()">选择书籍</button>
					</div>
					<div class="config-item">
						<label>每行字数:</label>
						<input type="number" id="lineLength" value="${lineLength}" min="5" max="50" onchange="saveLineLength(this.value)">
					</div>
					<div class="config-item">
						<label>显示进度:</label>
						<input type="checkbox" id="showProgress" ${showProgress ? 'checked' : ''} onchange="saveShowProgress(this.checked)">
					</div>
					<div class="config-item">
						<label>状态栏位置:</label>
						<select id="statusBarPosition" onchange="saveStatusBarPosition(this.value)">
							<option value="left" ${statusBarPosition === 'left' ? 'selected' : ''}>左侧</option>
							<option value="right" ${statusBarPosition === 'right' ? 'selected' : ''}>右侧</option>
						</select>
					</div>
					<div class="config-item">
						<label>状态栏优先级:</label>
						<input type="number" id="statusBarPriority" value="${statusBarPriority}" min="0" max="1000" onchange="saveStatusBarPriority(this.value)">
					</div>
				</div>

				<div class="section">
					<h2>阅读历史</h2>
					<div id="bookList"></div>
				</div>

				<div class="section">
					<h2>阅读统计</h2>
					<div id="readingStats"></div>
				</div>

				<script>
					const vscode = acquireVsCodeApi();
					
					vscode.postMessage({ command: 'getBooks' });
					
					window.addEventListener('message', event => {
						const message = event.data;
						if (message.command === 'updateBooks') {
							updateBookList(message.books);
						} else if (message.command === 'updateStats') {
							updateReadingStats(message.stats);
						}
					});

					function selectBookPath() {
						vscode.postMessage({ command: 'selectBookPath' });
					}

					function selectBook() {
						vscode.postMessage({ command: 'selectBook' });
					}

					function saveLineLength(value) {
						vscode.postMessage({ 
							command: 'saveLineLength',
							length: parseInt(value, 10)
						});
					}

					function saveShowProgress(checked) {
						vscode.postMessage({ 
							command: 'saveShowProgress',
							show: checked
						});
					}

					function saveStatusBarPosition(position) {
						vscode.postMessage({ 
							command: 'saveStatusBarPosition',
							position: position
						});
					}

					function saveStatusBarPriority(value) {
						vscode.postMessage({ 
							command: 'saveStatusBarPriority',
							priority: parseInt(value, 10)
						});
					}
					
					function updateBookList(books) {
						const bookList = document.getElementById('bookList');
						bookList.innerHTML = books.map(book => \`
							<div class="book-item">
								<div class="book-info">
									<div><strong>\${book.name}</strong></div>
									<div>进度: \${book.progress + 1}/\${book.total}</div>
									<div>最后阅读: \${new Date(book.lastRead).toLocaleString()}</div>
								</div>
								<span class="remove-btn" onclick="removeBook('\${book.name}')">删除</span>
							</div>
						\`).join('');
					}
					
					function removeBook(bookName) {
						vscode.postMessage({ command: 'removeBook', bookName });
					}

					function resetBookPath() {
						vscode.postMessage({ command: 'resetBookPath' });
					}

					function updateReadingStats(stats) {
						const statsDiv = document.getElementById('readingStats');
						const today = new Date().toISOString().split('T')[0];
						const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
						
						statsDiv.innerHTML = \`
							<div class="stats-item">
								<div>今日已读: \${stats[today] || 0} 字</div>
								<div>昨日已读: \${stats[yesterday] || 0} 字</div>
								<div>累计已读: \${Object.values(stats).reduce((a, b) => a + b, 0)} 字</div>
							</div>
						\`;
					}
					
					// 请求统计数据
					vscode.postMessage({ command: 'getReadingStats' });
				</script>
			</body>
			</html>
		`;
	}

	private static getReadingHistory() {
		const progress = vscode.workspace.getConfiguration('zloveread').get('readingProgress') as { [key: string]: number };
		const lastRead = vscode.workspace.getConfiguration('zloveread').get('lastReadTime') as { [key: string]: number };
		const bookPath = vscode.workspace.getConfiguration('zloveread').get('bookPath') as string;
		
		return Object.keys(progress).map(bookName => {
			const fullPath = path.join(bookPath, bookName);
			let total = 0;
			try {
				if (fs.existsSync(fullPath)) {
					const content = fs.readFileSync(fullPath, 'utf8').split('\n');
					total = content.length;
				}
			} catch (error) {
				console.error(`Error reading file: ${fullPath}`, error);
			}

			return {
				name: bookName,
				progress: progress[bookName],
				total: total,
				lastRead: lastRead[bookName] || Date.now()
			};
		});
	}

	private static async removeBook(bookName: string) {
		try {
			const progress = vscode.workspace.getConfiguration('zloveread').get('readingProgress') as { [key: string]: number };
			const lastRead = vscode.workspace.getConfiguration('zloveread').get('lastReadTime') as { [key: string]: number };
			const currentBook = vscode.workspace.getConfiguration('zloveread').get('currentBook') as string;
			
			if (!progress[bookName]) {
				vscode.window.showErrorMessage(`找不到《${bookName}》的阅读记录`);
				return;
			}
			
			// 创建新对象而不是直接修改
			const newProgress = { ...progress };
			const newLastRead = { ...lastRead };
			delete newProgress[bookName];
			delete newLastRead[bookName];
			
			await vscode.workspace.getConfiguration('zloveread').update('readingProgress', newProgress, true);
			await vscode.workspace.getConfiguration('zloveread').update('lastReadTime', newLastRead, true);
			
			// 如果删除的是当前正在阅读的书籍，清除当前书籍设置
			if (bookName === currentBook) {
				await vscode.workspace.getConfiguration('zloveread').update('currentBook', '', true);
				await vscode.commands.executeCommand('zloveread.reloadContent');
			}
			
			// 刷新列表
			const books = this.getReadingHistory();
			if (this.panel) {
				this.panel.webview.postMessage({ command: 'updateBooks', books });
			}
			
			vscode.window.showInformationMessage(`已删除《${bookName}》的阅读记录`);
		} catch (error) {
			console.error('删除阅读记录失败:', error);
			vscode.window.showErrorMessage(`删除阅读记录失败: ${error}`);
		}
	}

	static async handleWebviewMessage(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
		panel.webview.onDidReceiveMessage(async message => {
			try {
				switch (message.command) {
					case 'removeBook':
						if (message.bookName) {
							await this.removeBook(message.bookName);
						}
						break;
					case 'getBooks':
						const books = this.getReadingHistory();
						panel.webview.postMessage({ command: 'updateBooks', books });
						break;
					case 'selectBookPath':
						const folder = await vscode.window.showOpenDialog({
							canSelectFiles: false,
							canSelectFolders: true,
							canSelectMany: false
						});
						
						if (folder && folder[0]) {
							await vscode.workspace.getConfiguration('zloveread').update('bookPath', folder[0].fsPath, true);
							panel.webview.html = this.getWebviewContent();
						}
						break;
					case 'selectBook':
						await vscode.commands.executeCommand('zloveread.selectBook');
						panel.webview.html = this.getWebviewContent();
						break;
					case 'saveLineLength':
						await vscode.workspace.getConfiguration('zloveread').update('lineLength', message.length, true);
						await vscode.commands.executeCommand('zloveread.reloadContent');
						vscode.window.showInformationMessage('每行字数设置已保存');
						panel.webview.html = this.getWebviewContent();
						break;
					case 'saveShowProgress':
						await vscode.workspace.getConfiguration('zloveread').update('showProgress', message.show === true, true);
						await vscode.commands.executeCommand('zloveread.reloadContent');
						vscode.window.showInformationMessage('进度显示设置已保存');
						panel.webview.html = this.getWebviewContent();
						break;
					case 'saveStatusBarOrder':
						await vscode.workspace.getConfiguration('zloveread').update('statusBarOrder', message.order, true);
						await vscode.commands.executeCommand('zloveread.reloadContent');
						vscode.window.showInformationMessage('状态栏顺序设置已保存');
						panel.webview.html = this.getWebviewContent();
						break;
					case 'saveStatusBarPosition':
						await vscode.workspace.getConfiguration('zloveread').update('statusBarPosition', message.position, true);
						await vscode.commands.executeCommand('zloveread.updateStatusBarPosition');
						vscode.window.showInformationMessage('状态栏位置设置已保存');
						break;
					case 'saveStatusBarPriority':
						await vscode.workspace.getConfiguration('zloveread').update('statusBarPriority', message.priority, true);
						await vscode.commands.executeCommand('zloveread.updateStatusBarPosition');
						vscode.window.showInformationMessage('状态栏优先级设置已保存');
						break;
					case 'resetBookPath':
						const defaultBooksPath = path.join(context.globalStorageUri.fsPath, 'books');
						try {
							if (!fs.existsSync(defaultBooksPath)) {
								fs.mkdirSync(defaultBooksPath, { recursive: true });
								const defaultBooks = path.join(context.extensionPath, 'books');
								fs.readdirSync(defaultBooks).forEach(file => {
									fs.copyFileSync(
										path.join(defaultBooks, file),
										path.join(defaultBooksPath, file)
									);
								});
							}
							await vscode.workspace.getConfiguration('zloveread').update('bookPath', defaultBooksPath, true);
							panel.webview.html = this.getWebviewContent();
							vscode.window.showInformationMessage('已重置为默认电子书目录');
						} catch (error) {
							console.error('重置默认目录失败:', error);
							vscode.window.showErrorMessage(`重置默认目录失败: ${error}`);
						}
						break;
					case 'getReadingStats':
						const stats = vscode.workspace.getConfiguration('zloveread').get('dailyReadingStats') as DailyStats;
						panel.webview.postMessage({ command: 'updateStats', stats });
						break;
				}
			} catch (error) {
				console.error('处理 WebView 消息失败:', error);
				vscode.window.showErrorMessage(`操作失败: ${error}`);
			}
		});
	}
} 