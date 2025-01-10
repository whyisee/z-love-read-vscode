// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
const EPub = require('epub');
import { BookManager } from './bookManager';

interface BookContent {
	content: string[];
	format: 'txt' | 'epub';
	totalWords: number;
	processedContent: string[];
}

interface ReadingProgress {
	[key: string]: number;
}

interface LastReadTime {
	[key: string]: number;
}

interface DailyStats {
	[date: string]: number;  // 格式: "YYYY-MM-DD": 字数
}

let statusBarItem: vscode.StatusBarItem;
let currentPosition = 0;
let content: BookContent = { 
	content: [], 
	format: 'txt',
	totalWords: 0,
	processedContent: []
};
let currentBook: string = '';
let isReaderVisible = true;

const orderMap: { [key: string]: string } = {
	'1': 'progress,words,content',
	'2': 'progress,content,words',
	'3': 'words,progress,content',
	'4': 'words,content,progress',
	'5': 'content,progress,words',
	'6': 'content,words,progress'
};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('zloveread');
	const position = config.get('statusBarPosition', 'left');
	const priority = config.get('statusBarPriority', 100);
	
	statusBarItem = vscode.window.createStatusBarItem(
		position === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right,
		priority
	);
	statusBarItem.show();
	
	// 加载上次的阅读进度
	loadLastProgress();

	// 检查并设置默认书籍目录
	const bookPath = config.get('bookPath') as string;
	
	if (!bookPath) {
		// 将示例书籍复制到用户目录
		const defaultBooksPath = path.join(context.extensionPath, 'books');
		const userBooksPath = path.join(context.globalStorageUri.fsPath, 'books');
		
		try {
			if (!fs.existsSync(userBooksPath)) {
				fs.mkdirSync(userBooksPath, { recursive: true });
				// 复制示例书籍
				fs.readdirSync(defaultBooksPath).forEach(file => {
					fs.copyFileSync(
						path.join(defaultBooksPath, file),
						path.join(userBooksPath, file)
					);
				});
			}
			
			// 设置默认书籍目录
			await config.update('bookPath', userBooksPath, true);
			vscode.window.showInformationMessage('已设置默认电子书目录，并添加示例书籍');
		} catch (error) {
			console.error('设置默认书籍目录失败:', error);
		}
	}

	// 设置书籍目录
	let setBookPath = vscode.commands.registerCommand('zloveread.setBookPath', async () => {
		const folder = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false
		});
		
		if (folder && folder[0]) {
			await vscode.workspace.getConfiguration('zloveread').update('bookPath', folder[0].fsPath, true);
			vscode.window.showInformationMessage('电子书目录设置成功！');
		}
	});

	// 选择书籍
	let selectBook = vscode.commands.registerCommand('zloveread.selectBook', async () => {
		const bookPath = vscode.workspace.getConfiguration('zloveread').get('bookPath') as string;
		if (!bookPath) {
			vscode.window.showErrorMessage('请先设置电子书目录！');
			return;
		}

		const files = fs.readdirSync(bookPath).filter(file => 
			file.endsWith('.txt') || file.endsWith('.epub')
		);
		const selected = await vscode.window.showQuickPick(files, {
			placeHolder: '选择要阅读的电子书'
		});

		if (selected) {
			// 先清空当前内容
			content = { 
				content: [], 
				format: 'txt',
				totalWords: 0,
				processedContent: []
			};
			currentPosition = 0;
			
			// 更新当前书籍并加载内容
			currentBook = selected;
			await vscode.workspace.getConfiguration('zloveread').update('currentBook', selected, true);
			await loadBookContent(path.join(bookPath, selected));
			
			// 通知用户
			vscode.window.showInformationMessage(`已切换到《${selected}》`);
		}
	});

	// 加载书籍
	let loadBook = vscode.commands.registerCommand('zloveread.loadBook', async () => {
		const file = await vscode.window.showOpenDialog({
			filters: { 
				'Books': ['txt', 'epub'],
				'Text files': ['txt'],
				'EPUB files': ['epub']
			}
		});
		
		if (file && file[0]) {
			currentBook = path.basename(file[0].fsPath);
			await loadBookContent(file[0].fsPath);
		}
	});

	let nextLine = vscode.commands.registerCommand('zloveread.nextLine', () => {
		if (currentPosition < content.processedContent.length - 1) {
			currentPosition++;
			updateStatusBar();
			saveProgress();
			
			// 统计阅读字数
			const today = new Date().toISOString().split('T')[0];
			const stats = vscode.workspace.getConfiguration('zloveread').get('dailyReadingStats') as DailyStats;
			const currentLineWords = content.processedContent[currentPosition].length;
			
			stats[today] = (stats[today] || 0) + currentLineWords;
			vscode.workspace.getConfiguration('zloveread').update('dailyReadingStats', stats, true);
		}
	});

	let prevLine = vscode.commands.registerCommand('zloveread.prevLine', () => {
		if (currentPosition > 0) {
			currentPosition--;
			updateStatusBar();
			saveProgress();
		}
	});

	// 切换阅读视图
	let toggleReader = vscode.commands.registerCommand('zloveread.toggleReader', () => {
		if (isReaderVisible) {
			statusBarItem.hide();
			isReaderVisible = false;
		} else {
			statusBarItem.show();
			isReaderVisible = true;
		}
	});

	// 添加管理页面命令
	let manageBooks = vscode.commands.registerCommand('zloveread.manageBooks', () => {
		BookManager.show(context);
	});

	// 添加重新加载内容的命令
	let reloadContent = vscode.commands.registerCommand('zloveread.reloadContent', async () => {
		if (currentBook) {
			const bookPath = vscode.workspace.getConfiguration('zloveread').get('bookPath') as string;
			await loadBookContent(path.join(bookPath, currentBook));
		}
	});

	// 添加位置更新命令
	let updateStatusBarPosition = vscode.commands.registerCommand('zloveread.updateStatusBarPosition', async () => {
		const config = vscode.workspace.getConfiguration('zloveread');
		const position = config.get('statusBarPosition', 'left');
		const priority = config.get('statusBarPriority', 100);
		
		statusBarItem.dispose();
		statusBarItem = vscode.window.createStatusBarItem(
			position === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right,
			priority
		);
		statusBarItem.show();
		updateStatusBar();
	});

	context.subscriptions.push(statusBarItem);
	context.subscriptions.push(setBookPath);
	context.subscriptions.push(selectBook);
	context.subscriptions.push(loadBook);
	context.subscriptions.push(nextLine);
	context.subscriptions.push(prevLine);
	context.subscriptions.push(toggleReader);
	context.subscriptions.push(manageBooks);
	context.subscriptions.push(reloadContent);
	context.subscriptions.push(updateStatusBarPosition);
}

async function loadBookContent(filePath: string) {
	const ext = path.extname(filePath).toLowerCase();
	
	if (ext === '.txt') {
		const rawContent = fs.readFileSync(filePath, 'utf8').split('\n');
		const { processedContent, totalWords } = processContent(rawContent);
		content = {
			content: rawContent,
			processedContent,
			totalWords,
			format: 'txt'
		};
		currentPosition = getProgress(currentBook);
		updateStatusBar();
	} else if (ext === '.epub') {
		try {
			const epub = new EPub(filePath);
			content = await new Promise<BookContent>((resolve, reject) => {
				epub.on('end', async () => {
					let allContent: string[] = [];
					
					// 使用 Promise.all 等待所有章节加载完成
					await Promise.all(epub.flow.map((chapter: { id: string }) => {
						return new Promise<void>((resolveChapter, rejectChapter) => {
							epub.getChapter(chapter.id, (error: Error, text: string) => {
								if (error) {
									rejectChapter(error);
									return;
								}
								const cleanText = text.replace(/<[^>]*>/g, '');
								allContent = allContent.concat(cleanText.split('\n').filter(line => line.trim()));
								resolveChapter();
							});
						});
					}));

					const { processedContent, totalWords } = processContent(allContent);
					resolve({
						content: allContent,
						processedContent,
						totalWords,
						format: 'epub'
					});
				});
				
				epub.parse();
			});
			
			currentPosition = getProgress(currentBook);
			updateStatusBar();
		} catch (error: any) {
			vscode.window.showErrorMessage(`加载EPUB文件失败: ${error.message}`);
		}
	}
}

function updateStatusBar() {
	if (content.processedContent.length > 0) {
		const showProgress = vscode.workspace.getConfiguration('zloveread').get('showProgress', true);
		
		let statusText = '';
		
		if (showProgress) {
			statusText = `[${currentPosition + 1}/${content.processedContent.length}] `;
		}
		
		statusText += content.processedContent[currentPosition];
		statusBarItem.text = statusText;
		statusBarItem.tooltip = content.processedContent[currentPosition];
	}
}

function getProgress(bookName: string): number {
	const progress = vscode.workspace.getConfiguration('zloveread').get('readingProgress') as { [key: string]: number };
	return progress[bookName] || 0;
}

async function saveProgress() {
	const progress = vscode.workspace.getConfiguration('zloveread').get('readingProgress') as ReadingProgress;
	const lastRead = vscode.workspace.getConfiguration('zloveread').get('lastReadTime') as LastReadTime;
	
	progress[currentBook] = currentPosition;
	lastRead[currentBook] = Date.now();
	
	await vscode.workspace.getConfiguration('zloveread').update('readingProgress', progress, true);
	await vscode.workspace.getConfiguration('zloveread').update('lastReadTime', lastRead, true);
}

async function loadLastProgress() {
	const lastBook = vscode.workspace.getConfiguration('zloveread').get('currentBook') as string;
	const bookPath = vscode.workspace.getConfiguration('zloveread').get('bookPath') as string;
	
	if (lastBook && bookPath) {
		const fullPath = path.join(bookPath, lastBook);
		if (fs.existsSync(fullPath)) {
			currentBook = lastBook;
			await loadBookContent(fullPath);
		}
	}
}

// This method is called when your extension is deactivated
export function deactivate() {
	// 退出时保存进度
	if (currentBook) {
		saveProgress();
	}
}

function processContent(rawContent: string[]): { processedContent: string[], totalWords: number } {
	const lineLength = vscode.workspace.getConfiguration('zloveread').get('lineLength', 15);
	let processedContent: string[] = [];
	let totalWords = 0;
	let buffer = '';

	for (const line of rawContent) {
		const trimmedLine = line.trim();
		if (!trimmedLine) continue;
		
		totalWords += trimmedLine.length;
		buffer += trimmedLine;
		
		// 当缓冲区达到或超过行长度时，进行切分
		while (buffer.length >= lineLength) {
			processedContent.push(buffer.slice(0, lineLength));
			buffer = buffer.slice(lineLength);
		}
	}
	
	// 处理剩余的文本
	if (buffer.length > 0) {
		processedContent.push(buffer);
	}
	
	return { processedContent, totalWords };
}
