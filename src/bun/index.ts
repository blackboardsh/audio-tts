import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	type RPCSchema,
	Updater,
	Utils,
} from "electrobun/bun";

// Update types
type UpdateStatus =
	| "checking"
	| "update-available"
	| "downloading"
	| "update-ready"
	| "no-update"
	| "error";

interface UpdateInfo {
	status: UpdateStatus;

	currentVersion: string;
	newVersion?: string;
	error?: string;
}

// App configuration
const APP_NAME = "Audio TTS";
const APP_DATA_DIR = join(homedir(), ".audio-tts");
const PYTHON_DIR = join(APP_DATA_DIR, "python");
const MODELS_DIR = join(APP_DATA_DIR, "models");
const VOICES_DIR = join(APP_DATA_DIR, "voices");
const OUTPUT_DIR = join(APP_DATA_DIR, "output");
const BACKEND_PORT = 8765;

// Ensure directories exist
[APP_DATA_DIR, PYTHON_DIR, MODELS_DIR, VOICES_DIR, OUTPUT_DIR].forEach(
	(dir) => {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	},
);

// Backend process reference
let backendProcess: Subprocess | null = null;
let backendReady = false;

// Setup state
interface SetupState {
	uvInstalled: boolean;
	pythonInstalled: boolean;
	depsInstalled: boolean;
	backendRunning: boolean;
	error?: string;
}

let setupState: SetupState = {
	uvInstalled: false,
	pythonInstalled: false,
	depsInstalled: false,
	backendRunning: false,
};

// Update state
const updateState: UpdateInfo = {
	status: "checking",
	currentVersion: "0.0.0",
};

// Reference to main window for broadcasting updates
let mainWindowRef: BrowserWindow | null = null;

// Broadcast update status to the UI
const broadcastUpdateStatus = () => {
	mainWindowRef?.webview.rpc?.send.updateStatus(updateState);
};

// Check for updates
const checkForUpdate = async () => {
	try {
		const localInfo = await Updater.getLocallocalInfo();
		updateState.currentVersion = localInfo.version;
		updateState.status = "checking";
		broadcastUpdateStatus();

		console.log(`Current version: ${localInfo.version} (${localInfo.channel})`);

		const updateInfo = await Updater.checkForUpdate();

		if (updateInfo.error) {
			console.log(`Update check error: ${updateInfo.error}`);
			updateState.status = "error";
			updateState.error = updateInfo.error;
			broadcastUpdateStatus();
			return;
		}

		if (updateInfo.updateAvailable) {
			console.log(`Update available: ${updateInfo.version}`);
			updateState.status = "update-available";
			updateState.newVersion = updateInfo.version;
			broadcastUpdateStatus();

			// Start downloading
			updateState.status = "downloading";
			broadcastUpdateStatus();

			await Updater.downloadUpdate();

			if (Updater.updateInfo().updateReady) {
				console.log("Update downloaded and ready to install");
				updateState.status = "update-ready";
				broadcastUpdateStatus();
			} else {
				console.log("Update download failed");
				updateState.status = "error";
				updateState.error = "Download failed";
				broadcastUpdateStatus();
			}
		} else {
			console.log("No update available");
			updateState.status = "no-update";
			broadcastUpdateStatus();
		}
	} catch (err: any) {
		console.log(`Update check failed: ${err.message}`);
		updateState.status = "error";
		updateState.error = err.message;
		broadcastUpdateStatus();
	}
};

// ========== Utility Functions ==========

async function runCommand(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: Record<string, string> },
): Promise<{ success: boolean; output: string; error: string }> {
	try {
		const proc = spawn([command, ...args], {
			cwd: options?.cwd,
			env: { ...process.env, ...options?.env } as any,
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = await new Response(proc.stdout).text();
		const error = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		return {
			success: exitCode === 0,
			output: output.trim(),
			error: error.trim(),
		};
	} catch (e) {
		return {
			success: false,
			output: "",
			error: String(e),
		};
	}
}

async function checkCommand(command: string): Promise<boolean> {
	const result = await runCommand("which", [command]);
	return result.success;
}

// ========== Setup Functions ==========

async function checkUvInstalled(): Promise<boolean> {
	if (await checkCommand("uv")) {
		return true;
	}

	const uvPaths = [
		join(homedir(), ".local", "bin", "uv"),
		join(homedir(), ".cargo", "bin", "uv"),
		"/usr/local/bin/uv",
	];

	for (const path of uvPaths) {
		if (existsSync(path)) {
			return true;
		}
	}

	return false;
}

async function installUv(): Promise<boolean> {
	console.log("Installing uv...");

	const result = await runCommand("sh", [
		"-c",
		"curl -LsSf https://astral.sh/uv/install.sh | sh",
	]);

	if (result.success) {
		console.log("uv installed successfully");
		return true;
	} else {
		console.error("Failed to install uv:", result.error);
		return false;
	}
}

async function getUvPath(): Promise<string> {
	if (await checkCommand("uv")) {
		return "uv";
	}

	const uvPaths = [
		join(homedir(), ".local", "bin", "uv"),
		join(homedir(), ".cargo", "bin", "uv"),
		"/usr/local/bin/uv",
	];

	for (const path of uvPaths) {
		if (existsSync(path)) {
			return path;
		}
	}

	throw new Error("uv not found");
}

async function setupPythonEnvironment(): Promise<boolean> {
	console.log("Setting up Python environment...");

	const uvPath = await getUvPath();
	const venvPath = join(PYTHON_DIR, ".venv");

	if (!existsSync(venvPath)) {
		console.log("Creating Python 3.10 virtual environment...");
		const result = await runCommand(uvPath, [
			"venv",
			"--python",
			"3.10",
			venvPath,
		]);

		if (!result.success) {
			console.error("Failed to create venv:", result.error);
			return false;
		}
	}

	return true;
}

async function installPythonDependencies(): Promise<boolean> {
	console.log("Installing Python dependencies...");

	const uvPath = await getUvPath();
	const venvPath = join(PYTHON_DIR, ".venv");

	let pythonSrcDir: string | undefined;

	// Possible locations for python source files
	// import.meta.dir = app/bun/, so ".." gets us to app/, then "python" is the folder
	const possiblePaths = [
		join(import.meta.dir, "..", "python"), // In app bundle: app/bun/../python = app/python
		join(process.cwd(), "python"), // Development: project root
		join(APP_DATA_DIR, "python-src"), // Already copied to app data
	];

	console.log("Searching for Python source in:", possiblePaths);

	for (const path of possiblePaths) {
		const checkPath = join(path, "requirements.txt");
		console.log(`Checking: ${checkPath}`);
		if (existsSync(checkPath)) {
			pythonSrcDir = path;
			console.log(`Found Python source at: ${path}`);
			break;
		}
	}

	if (!pythonSrcDir) {
		console.error(
			"Could not find python source directory in any of:",
			possiblePaths,
		);
		return false;
	}

	const pythonAppSrcDir = join(APP_DATA_DIR, "python-src");
	if (!existsSync(pythonAppSrcDir)) {
		mkdirSync(pythonAppSrcDir, { recursive: true });
	}

	const filesToCopy = ["requirements.txt", "server.py", "tts_service.py"];
	for (const file of filesToCopy) {
		const srcPath = join(pythonSrcDir, file);
		const destPath = join(pythonAppSrcDir, file);
		if (existsSync(srcPath)) {
			const content = readFileSync(srcPath);
			writeFileSync(destPath, content);
		}
	}

	const requirementsPath = join(pythonAppSrcDir, "requirements.txt");
	const pipPath = join(venvPath, "bin", "pip");

	const result = await runCommand(
		uvPath,
		[
			"pip",
			"install",
			"-r",
			requirementsPath,
			"--python",
			join(venvPath, "bin", "python"),
		],
		{ cwd: pythonAppSrcDir },
	);

	if (!result.success) {
		console.error("Failed to install dependencies:", result.error);
		const pipResult = await runCommand(
			pipPath,
			["install", "-r", requirementsPath],
			{
				cwd: pythonAppSrcDir,
			},
		);
		if (!pipResult.success) {
			console.error("Fallback pip install also failed:", pipResult.error);
			return false;
		}
	}

	console.log("Python dependencies installed");
	return true;
}

async function startBackend(): Promise<boolean> {
	console.log("Starting Python backend...");

	const venvPath = join(PYTHON_DIR, ".venv");
	const pythonPath = join(venvPath, "bin", "python");
	const pythonSrcDir = join(APP_DATA_DIR, "python-src");
	const serverPath = join(pythonSrcDir, "server.py");

	if (!existsSync(pythonPath)) {
		console.error("Python not found at:", pythonPath);
		return false;
	}

	if (!existsSync(serverPath)) {
		console.error("Server script not found at:", serverPath);
		return false;
	}

	// Get certifi cert path from the venv for SSL support
	// (standalone Python from uv may not find system certs)
	let sslCertFile = "";
	try {
		const certResult = Bun.spawnSync([
			pythonPath,
			"-c",
			"import certifi; print(certifi.where())",
		]);
		sslCertFile = certResult.stdout.toString().trim();
		if (sslCertFile) {
			console.log("SSL cert file:", sslCertFile);
		}
	} catch {
		console.warn("Could not get certifi cert path");
	}

	const env: Record<string, string> = {
		...(process.env as any),
		PORT: String(BACKEND_PORT),
		PYTORCH_ENABLE_MPS_FALLBACK: "1",
		PYTHONUNBUFFERED: "1",
		...(sslCertFile
			? {
					SSL_CERT_FILE: sslCertFile,
					REQUESTS_CA_BUNDLE: sslCertFile,
				}
			: {}),
	};

	backendProcess = spawn([pythonPath, serverPath], {
		cwd: pythonSrcDir,
		env: env as any,
		stdout: "pipe",
		stderr: "pipe",
	});

	// Log backend output
	(async () => {
		const reader = backendProcess?.stdout.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			console.log("[Backend]", new TextDecoder().decode(value));
		}
	})();

	(async () => {
		const reader = backendProcess?.stderr.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			console.error("[Backend Error]", new TextDecoder().decode(value));
		}
	})();

	// Wait for backend to be ready
	const maxRetries = 30;
	for (let i = 0; i < maxRetries; i++) {
		await new Promise((resolve) => setTimeout(resolve, 1000));

		try {
			const response = await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`);
			if (response.ok) {
				console.log("Backend is ready");
				backendReady = true;
				return true;
			}
		} catch {
			// Not ready yet
		}
	}

	console.error("Backend failed to start within timeout");
	return false;
}

async function stopBackend(): Promise<void> {
	if (backendProcess) {
		console.log("Stopping backend...");
		backendProcess.kill();
		backendProcess = null;
		backendReady = false;
	}
}

// ========== Main Application ==========

async function runSetup(): Promise<SetupState> {
	setupState = {
		uvInstalled: false,
		pythonInstalled: false,
		depsInstalled: false,
		backendRunning: false,
	};

	setupState.uvInstalled = await checkUvInstalled();
	if (!setupState.uvInstalled) {
		setupState.uvInstalled = await installUv();
		if (!setupState.uvInstalled) {
			setupState.error = "Failed to install uv package manager";
			return setupState;
		}
	}

	setupState.pythonInstalled = await setupPythonEnvironment();
	if (!setupState.pythonInstalled) {
		setupState.error = "Failed to setup Python environment";
		return setupState;
	}

	setupState.depsInstalled = await installPythonDependencies();
	if (!setupState.depsInstalled) {
		setupState.error = "Failed to install Python dependencies";
		return setupState;
	}

	setupState.backendRunning = await startBackend();
	if (!setupState.backendRunning) {
		setupState.error = "Failed to start backend server";
		return setupState;
	}

	return setupState;
}

// ========== RPC Schema Definition ==========

// Define the RPC schema for communication between bun and webview
type AppRPCSchema = {
	bun: RPCSchema<{
		requests: {
			getSetupState: {
				params: {};
				response: SetupState;
			};
			runSetup: {
				params: {};
				response: SetupState;
			};
			getBackendStatus: {
				params: {};
				response: { running: boolean; port: number; url: string };
			};
			getPaths: {
				params: {};
				response: {
					appData: string;
					models: string;
					voices: string;
					output: string;
				};
			};
			openFolder: {
				params: { path: string };
				response: void;
			};
			backendRequest: {
				params: { method: string; path: string; body?: any };
				response: { status: number; data: any };
			};
			getUpdateState: {
				params: {};
				response: UpdateInfo;
			};
			applyUpdate: {
				params: {};
				response: undefined;
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			updateStatus: UpdateInfo;
		};
	}>;
};

// Create the RPC with handlers
const rpc = BrowserView.defineRPC<AppRPCSchema>({
	maxRequestTime: 60000, // 60 second timeout for long operations
	handlers: {
		requests: {
			getSetupState: async () => {
				return setupState;
			},

			runSetup: async () => {
				return await runSetup();
			},

			getBackendStatus: async () => {
				return {
					running: backendReady,
					port: BACKEND_PORT,
					url: `http://127.0.0.1:${BACKEND_PORT}`,
				};
			},

			getPaths: async () => {
				return {
					appData: APP_DATA_DIR,
					models: MODELS_DIR,
					voices: VOICES_DIR,
					output: OUTPUT_DIR,
				};
			},

			openFolder: async ({ path }) => {
				spawn(["open", path]);
			},

			backendRequest: async ({ method, path, body }) => {
				if (!backendReady) {
					throw new Error("Backend not ready");
				}

				const url = `http://127.0.0.1:${BACKEND_PORT}${path}`;

				const response = await fetch(url, {
					method: method || "GET",
					headers: body ? { "Content-Type": "application/json" } : undefined,
					body: body ? JSON.stringify(body) : undefined,
				});

				const data = await response.json();
				return { status: response.status, data };
			},

			getUpdateState: async () => {
				return updateState;
			},

			applyUpdate: async () => {
				console.log("Applying update...");
				Updater.applyUpdate();
			},
		},
		messages: {},
	},
});

// ========== Application Menu ==========

ApplicationMenu.setApplicationMenu([
	{
		label: APP_NAME,
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "showAll" },
			{ type: "separator" },
			{ role: "quit" },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "pasteAndMatchStyle" },
			{ role: "delete" },
			{ role: "selectAll" },
		],
	},
	{
		label: "Window",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			{ role: "close" },
		],
	},
]);

// ========== Window Creation ==========

console.log(`${APP_NAME} starting...`);
console.log(`App data directory: ${APP_DATA_DIR}`);

// Create the main window with RPC
const mainWindow = new BrowserWindow({
	title: APP_NAME,
	url: "views://mainview/index.html",
	frame: {
		width: 1200,
		height: 800,
		x: 100,
		y: 100,
	},
	rpc,
});

// Save reference for broadcasting updates
mainWindowRef = mainWindow;

// Send update status when DOM is ready
mainWindow.webview.on("dom-ready", () => {
	broadcastUpdateStatus();
});

// Handle window close
mainWindow.on("close", async () => {
	await stopBackend();
	Utils.quit();
});

// Start setup automatically
console.log("Running initial setup...");
runSetup().then((state) => {
	if (state.error) {
		console.error("Setup failed:", state.error);
	} else {
		console.log("Setup complete. Backend running on port", BACKEND_PORT);
	}
});

// Check for updates on startup
checkForUpdate();

console.log(`${APP_NAME} started!`);
