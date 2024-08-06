import * as vscode from 'vscode';
import { stringify } from 'yaml';
import { getNodeCanvas, loadDiagram, renderSvg, DiagramValidationError } from '@allioide/diagram-visualizer';

async function isFileExist(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function getDirPath(path: string): string {
	const index = path.lastIndexOf('/');
	return path.substring(0, index);
}

function getBasename(path: string): string {
	const index = path.lastIndexOf('/');
	const basename = path.substring(index + 1);
	return basename;
}

function getBasenameWithoutExt(path: string): string {
	return getBasename(path).split('.')[0];
}

async function newDiagram(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		// we shouldn't reach here as the command is hidden when the number of workspace folders != 1
		vscode.window.showErrorMessage('Please open a folder to create the diagram.');
	} else {
		let filename = await vscode.window.showInputBox({ title: 'New AllIO diagram...', placeHolder: 'untitled' });
		if (filename === undefined) {
			return;
		}
		if (filename.length === 0) {
			filename = 'untitled';
		}
		const outputUri = vscode.Uri.joinPath(workspaceFolders[0].uri, `${filename}.alliodiagram`);
		if (await isFileExist(outputUri)) {
			vscode.window.showErrorMessage(`The file name ${filename}.alliodiagram exists in the current directory.`);
			return;
		}
		const content = stringify({ devices: [], diagrams: [] });
		try {
			await vscode.workspace.fs.writeFile(outputUri, Buffer.from(content));
		} catch {
			vscode.window.showErrorMessage(`Can't create file (${filename}.alliodiagram)`);
		}
	}
}

async function exportDiagram(doc: vscode.TextDocument): Promise<void> {
	const fileContentByte = await vscode.workspace.fs.readFile(doc.uri);
	const fileContentString = new TextDecoder().decode(fileContentByte);
	const diagram = loadDiagram(fileContentString);
	const canvas = getNodeCanvas();
	const svgString = renderSvg(diagram, canvas);

	const defaultUri = vscode.Uri.joinPath(
		vscode.Uri.parse(getDirPath(doc.uri.fsPath)),
		`${getBasenameWithoutExt(doc.uri.fsPath)}.svg`);
	const outputUri = await vscode.window.showSaveDialog({title: 'Export Diagram Image', filters: {'Images': ['svg']}, defaultUri: defaultUri});
	if (outputUri) {
		await vscode.workspace.fs.writeFile(outputUri, Buffer.from(svgString));
	}
}

function generatePreviewWindowHtml(body: string): string {
	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">

		<title>AllIO Diagram</title>
	</head>
	<body>
	<div id="content" style="background-color: #FFFFFF; padding: 10px; display: inline-block;">
		${body}
	</div>
	<script>
		function getCurrentDimension() {
			const svg = document.getElementsByTagName('svg')[0];
			return { w: svg.getAttribute('width'), h: svg.getAttribute('height') };
		}	
		function updateDimension(w, h) {
			const svg = document.getElementsByTagName('svg')[0];
			if (svg) {
				svg.setAttribute('width', w);
				svg.setAttribute('height', h);
			}
		}
		
		let initialDimension = getCurrentDimension();
		let currentZoomLevel = 1.0;
		
		window.addEventListener('message', event => {
            const message = event.data;
			switch (message.type) {
                case 'update':
					const content = document.getElementById('content');
					content.innerHTML = message.content;
					initialDimension = getCurrentDimension();
					updateDimension(initialDimension.w * currentZoomLevel, initialDimension.h * currentZoomLevel);
					break;
				case 'zoom-in':
					currentZoomLevel += 0.1;
					updateDimension(initialDimension.w * currentZoomLevel, initialDimension.h * currentZoomLevel);
					break;
				case 'zoom-out':
					if (currentZoomLevel < 0.2) {	// minimum zoom level is 0.1
						break;
					}
					currentZoomLevel -= 0.1;
					updateDimension(initialDimension.w * currentZoomLevel, initialDimension.h * currentZoomLevel);
					break;
				case 'zoom-reset':
					currentZoomLevel = 1.0;
					updateDimension(initialDimension.w, initialDimension.h);
					break;
			}	
        });
	</script>
	</body>
	</html>`;
}

async function getDiagramPreviewContent(path: vscode.Uri): Promise<string> {
	const fileContentByte = await vscode.workspace.fs.readFile(path);
	const fileContentString = new TextDecoder().decode(fileContentByte);
	try {
		const diagram = loadDiagram(fileContentString);
		const canvas = getNodeCanvas();
		const svgString = renderSvg(diagram, canvas);
		return svgString;
	} catch (err) {
		if (err instanceof DiagramValidationError) {
			return 'Syntax error';
		} else {
			return `${(err as Error).message}<br>${(err as Error).stack ?? ''}`;
		}
	}
}

function getActivePreviewPanel(panel: IterableIterator<vscode.WebviewPanel>): vscode.WebviewPanel | undefined {
	for (const p of panel) {
		if (p.active) {
			return p;
		}
	}
	return undefined;
}

export function activate(context: vscode.ExtensionContext) {
	const fileConfiguration = vscode.workspace.getConfiguration('files');
	const associations = fileConfiguration.get<{ [key: string]: string }>('associations') || {};
	associations['*.alliodiagram'] = "yaml";
	fileConfiguration.update('associations', associations, false).then(() => {
		console.log('Registered file association');
	});

	const yamlConfiguration = vscode.workspace.getConfiguration('yaml');
	const schemas = fileConfiguration.get<{ [key: string]: string }>('schemas') || {};
	schemas["https://raw.githubusercontent.com/allioide/allio-diagram-visualizer/main/src/schema/alliodiagram.json"] = "*.alliodiagram";
	yamlConfiguration.update('schemas', schemas, false).then(() => {
		console.log('Registered diagram schema');
	});

	const previewPanelOwnerMap = new Map<vscode.WebviewPanel, vscode.TextDocument>();
	context.subscriptions.push(vscode.commands.registerCommand('allio-vscode-extension.newDiagram', async () => {
		await newDiagram();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('allio-vscode-extension.exportDiagramAsSvg', async () => {
		const activePreviewPanel = getActivePreviewPanel(previewPanelOwnerMap.keys());
		const doc = activePreviewPanel ? previewPanelOwnerMap.get(activePreviewPanel) : vscode.window.activeTextEditor?.document;
		if (doc) {
			await exportDiagram(doc);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('allio-vscode-extension.openPreview', () => {
		const doc = vscode.window.activeTextEditor?.document;
		if (!doc) {
			vscode.window.showErrorMessage('Can\'t open a preview window (no active document)');
			return;
		}

		const previewPanel = vscode.window.createWebviewPanel('allioDiagramPreview', `Preview ${getBasename(doc.fileName)}`, vscode.ViewColumn.Beside, { enableScripts: true });
		previewPanelOwnerMap.set(previewPanel, doc);

		getDiagramPreviewContent(doc.uri).then((value) => {
			previewPanel.webview.html = generatePreviewWindowHtml(value);
		});
		const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument(e => {
			if (e.uri.toString() === doc.uri.toString()) {
				getDiagramPreviewContent(doc.uri).then((value) => {
					previewPanel.webview.postMessage({ type: 'update', content: value });
				});
			}
		});

		previewPanel.onDidDispose(() => {
			saveDocumentSubscription.dispose();
			previewPanelOwnerMap.delete(previewPanel);
		}, null, context.subscriptions);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('allio-vscode-extension.zoomInDiagram', () => {
		const panel = getActivePreviewPanel(previewPanelOwnerMap.keys());
		if (panel) {
			panel.webview.postMessage({ type: 'zoom-in' });
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('allio-vscode-extension.zoomOutDiagram', () => {
		const panel = getActivePreviewPanel(previewPanelOwnerMap.keys());
		if (panel) {
			panel.webview.postMessage({ type: 'zoom-out' });
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('allio-vscode-extension.resetZoomDiagram', () => {
		const panel = getActivePreviewPanel(previewPanelOwnerMap.keys());
		if (panel) {
			panel.webview.postMessage({ type: 'zoom-reset' });
		}
	}));
}

export function deactivate() { }
