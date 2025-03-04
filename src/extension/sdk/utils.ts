import * as fs from "fs";
import * as path from "path";
import { commands, ExtensionContext, window } from "vscode";
import { analyzerSnapshotPath, dartPlatformName, dartVMPath, DART_DOWNLOAD_URL, executableNames, flutterPath, FLUTTER_CREATE_PROJECT_TRIGGER_FILE, FLUTTER_DOWNLOAD_URL, isLinux, isMac, isWin, showLogAction, snapBinaryPath, snapFlutterBinaryPath } from "../../shared/constants";
import { Logger, Sdks, SdkSearchResults, WorkspaceConfig } from "../../shared/interfaces";
import { nullLogger } from "../../shared/logging";
import { PackageMap } from "../../shared/pub/package_map";
import { flatMap, isDartSdkFromFlutter, notUndefined } from "../../shared/utils";
import { fsPath, getSdkVersion, hasPubspec } from "../../shared/utils/fs";
import { resolvedPromise } from "../../shared/utils/promises";
import { processBazelWorkspace, processFuchsiaWorkspace, processKnownGitRepositories } from "../../shared/utils/workspace";
import { envUtils, getAllProjectFolders, getDartWorkspaceFolders } from "../../shared/vscode/utils";
import { WorkspaceContext } from "../../shared/workspace";
import { Analytics } from "../analytics";
import { config } from "../config";
import { ringLog } from "../extension";
import { getExcludedFolders, openLogContents, promptToReloadExtension, resolvePaths } from "../utils";
import { initializeFlutterSdk } from "./flutter";

// TODO: Tidy this class up (it exists mainly to share logger).
export class SdkUtils {
	constructor(private readonly logger: Logger) { }

	public handleMissingSdks(context: ExtensionContext, analytics: Analytics, workspaceContext: WorkspaceContext) {
		// Note: This code only runs if we fail to find the Dart SDK, or fail to find the Flutter SDK
		// and are in a Flutter project. In the case where we fail to find the Flutter SDK but are not
		// in a Flutter project (eg. we ran Flutter Doctor without the extension activated) then
		// this code will not be run as the extension will activate normally, and then the command-handling
		// code for each command will detect the missing Flutter SDK and respond appropriately.
		context.subscriptions.push(commands.registerCommand("flutter.createProject", () => {
			this.showRelevantActivationFailureMessage(analytics, workspaceContext, true, "flutter.createProject");
		}));
		context.subscriptions.push(commands.registerCommand("dart.createProject", () => {
			this.showRelevantActivationFailureMessage(analytics, workspaceContext, false, "dart.createProject");
		}));
		context.subscriptions.push(commands.registerCommand("_dart.flutter.createSampleProject", () => {
			this.showRelevantActivationFailureMessage(analytics, workspaceContext, true, "_dart.flutter.createSampleProject");
		}));
		context.subscriptions.push(commands.registerCommand("flutter.doctor", () => {
			this.showRelevantActivationFailureMessage(analytics, workspaceContext, true, "flutter.doctor");
		}));
		context.subscriptions.push(commands.registerCommand("flutter.upgrade", () => {
			this.showRelevantActivationFailureMessage(analytics, workspaceContext, true, "flutter.upgrade");
		}));
		// Wait a while before showing the error to allow the code above to have run if it will.
		setTimeout(() => {
			// Only show the "startup" message if we didn't already show another message as
			// a result of one of the above commands beinv invoked.
			if (!this.hasShownActivationFailure) {
				if (workspaceContext.hasAnyFlutterProjects) {
					this.showRelevantActivationFailureMessage(analytics, workspaceContext, true);
				} else if (workspaceContext.hasAnyStandardDartProjects) {
					this.showRelevantActivationFailureMessage(analytics, workspaceContext, false);
				} else {
					this.logger.error("No Dart or Flutter SDK was found. Suppressing prompt because it doesn't appear that a Dart/Flutter project is open.");
				}
			}
		}, 500);
		return;
	}

	private hasShownActivationFailure = false;
	private showRelevantActivationFailureMessage(analytics: Analytics, workspaceContext: WorkspaceContext, isFlutter: boolean, commandToReRun?: string) {
		if (isFlutter && workspaceContext.sdks.flutter && !workspaceContext.sdks.dart) {
			this.showFluttersDartSdkActivationFailure();
		} else if (isFlutter) {
			this.showFlutterActivationFailure(commandToReRun);
		} else {
			this.showDartActivationFailure(commandToReRun);
		}
		if (!this.hasShownActivationFailure) {
			analytics.logSdkDetectionFailure();
			this.hasShownActivationFailure = true;
		}
	}

	public showFluttersDartSdkActivationFailure() {
		// tslint:disable-next-line: no-floating-promises
		promptToReloadExtension("Could not find Dart in your Flutter SDK. " +
			"Please run 'flutter doctor' in the terminal then reload the project once all issues are resolved.",
			"Reload", // eslint-disable-line @typescript-eslint/indent
			true, // eslint-disable-line @typescript-eslint/indent
		);
	}
	public showFlutterActivationFailure(commandToReRun?: string) {
		// tslint:disable-next-line: no-floating-promises
		this.showSdkActivationFailure(
			"Flutter",
			(p) => this.findFlutterSdk(p),
			FLUTTER_DOWNLOAD_URL,
			(p) => config.setGlobalFlutterSdkPath(p),
			commandToReRun,
		);
	}
	public showDartActivationFailure(commandToReRun?: string) {
		// tslint:disable-next-line: no-floating-promises
		this.showSdkActivationFailure(
			"Dart",
			(p) => this.findDartSdk(p),
			DART_DOWNLOAD_URL,
			(p) => config.setGlobalDartSdkPath(p),
			commandToReRun,
		);
	}

	public async showSdkActivationFailure(
		sdkType: string,
		search: (path: string[]) => SdkSearchResults,
		downloadUrl: string,
		saveSdkPath: (path: string) => Thenable<void>,
		commandToReRun?: string,
	) {
		const locateAction = "Locate SDK";
		const downloadAction = "Download SDK";
		let displayMessage = `Could not find a ${sdkType} SDK. ` +
			`Please ensure ${sdkType.toLowerCase()} is installed and in your PATH (you may need to restart).`;
		while (true) {
			const ringLogContents = ringLog.toString();
			const selectedItem = await window.showErrorMessage(displayMessage,
				locateAction,
				downloadAction,
				showLogAction,
			);
			// TODO: Refactor/reformat/comment this code - it's messy and hard to understand!
			if (selectedItem === locateAction) {
				const selectedFolders =
					await window.showOpenDialog({ canSelectFolders: true, openLabel: `Set ${sdkType} SDK folder` });
				if (selectedFolders && selectedFolders.length > 0) {
					const matchingSdkFolder = search(selectedFolders.map(fsPath));
					if (matchingSdkFolder.sdkPath) {
						await saveSdkPath(matchingSdkFolder.sdkPath);
						await promptToReloadExtension();
						if (commandToReRun) {
							commands.executeCommand(commandToReRun);
						}
						break;
					} else {
						displayMessage = `That folder does not appear to be a ${sdkType} SDK.`;
					}
				}
			} else if (selectedItem === downloadAction) {
				await envUtils.openInBrowser(downloadUrl);
				break;
			} else if (selectedItem === showLogAction) {
				openLogContents(undefined, ringLogContents);
				break;
			} else {
				break;
			}
		}
	}

	public async scanWorkspace(): Promise<WorkspaceContext> {
		this.logger.info("Searching for SDKs...");
		const pathOverride = (process.env.DART_PATH_OVERRIDE as string) || "";
		const normalPath = (process.env.PATH as string) || "";
		const paths = (pathOverride + path.delimiter + normalPath).split(path.delimiter).filter((p) => p);

		this.logger.info("Environment PATH:");
		for (const p of paths)
			this.logger.info(`    ${p}`);

		// If we are running the analyzer remotely over SSH, we only support an analyzer, since none
		// of the other SDKs will work remotely. Also, there is no need to validate the sdk path,
		// since that file will exist on a remote machine.
		if (config.analyzerSshHost) {
			return new WorkspaceContext({
				dart: config.sdkPath,
				dartSdkIsFromFlutter: false,
				flutter: undefined,
			} as Sdks, {}, false, false, false, false);
		}

		// TODO: This has gotten very messy and needs tidying up...

		let firstFlutterMobileProject: string | undefined;
		let hasAnyFlutterProject: boolean = false;
		let hasAnyFlutterMobileProject: boolean = false;
		let hasAnyWebProject: boolean = false;
		let hasAnyStandardDartProject: boolean = false;

		const possibleProjects = await getAllProjectFolders(this.logger, getExcludedFolders);

		// Scan through them all to figure out what type of projects we have.
		for (const folder of possibleProjects) {
			const hasPubspecFile = hasPubspec(folder);
			const refsFlutter = hasPubspecFile && referencesFlutterSdk(folder);
			const refsWeb = false; // hasPubspecFile && referencesWeb(folder);
			const hasFlutterCreateProjectTriggerFile =
				fs.existsSync(path.join(folder, FLUTTER_CREATE_PROJECT_TRIGGER_FILE));

			// Special case to detect the Flutter repo root, so we always consider it a Flutter project and will use the local SDK
			const isFlutterRepo = fs.existsSync(path.join(folder, "bin/flutter")) && fs.existsSync(path.join(folder, "bin/cache/dart-sdk"));

			// Since we just blocked on a lot of sync FS, yield.
			await resolvedPromise;

			const isSomethingFlutter = refsFlutter || hasFlutterCreateProjectTriggerFile || isFlutterRepo;

			if (isSomethingFlutter) {
				this.logger.info(`Found Flutter project at ${folder}:
			Mobile? ${refsFlutter}
			Web? ${refsWeb}
			Create Trigger? ${hasFlutterCreateProjectTriggerFile}
			Flutter Repo? ${isFlutterRepo}`);
			}

			// Track the first Flutter Project so we can try finding the Flutter SDK from its packages file.
			firstFlutterMobileProject = firstFlutterMobileProject || (isSomethingFlutter ? folder : undefined);

			// Set some flags we'll use to construct the workspace, so we know what things we need to light up.
			hasAnyFlutterProject = hasAnyFlutterProject || isSomethingFlutter;
			hasAnyFlutterMobileProject = hasAnyFlutterMobileProject || refsFlutter || hasFlutterCreateProjectTriggerFile;
			hasAnyWebProject = hasAnyWebProject || refsWeb;
			hasAnyStandardDartProject = hasAnyStandardDartProject || (!isSomethingFlutter && hasPubspecFile);
		}

		// Certain types of workspaces will have special config, so read them here.
		const workspaceConfig: WorkspaceConfig = {};
		// Helper that searches for a specific folder/file up the tree and
		// runs some specific processing.
		const workspaceFolders = getDartWorkspaceFolders();
		const topLevelFolders = workspaceFolders.map((w) => fsPath(w.uri));
		const processWorkspaceType = async (search: (logger: Logger, folder: string) => Promise<string | undefined>, process: (logger: Logger, config: WorkspaceConfig, folder: string) => void): Promise<string | undefined> => {
			for (const folder of topLevelFolders) {
				const root = await search(this.logger, folder);
				if (root) {
					process(this.logger, workspaceConfig, root);
					return root;
				}
			}
			return undefined;
		};

		await processWorkspaceType(findGitRoot, processKnownGitRepositories);
		// TODO: Remove this lambda when the preview flag is removed.
		await processWorkspaceType(findBazelWorkspaceRoot, (l, c, b) => processBazelWorkspace(l, c, b, config.previewBazelWorkspaceCustomScripts));
		const fuchsiaRoot = await processWorkspaceType(findFuchsiaRoot, processFuchsiaWorkspace);

		if (fuchsiaRoot) {
			this.logger.info(`Found Fuchsia root at ${fuchsiaRoot}`);
			if (hasAnyStandardDartProject)
				this.logger.info(`Found Fuchsia project that is not vanilla Flutter`);
		}

		const flutterSdkSearchPaths = [
			workspaceConfig?.flutterSdkHome,
			config.flutterSdkPath,
			// TODO: These could move into processFuchsiaWorkspace and be set on the config?
			fuchsiaRoot && path.join(fuchsiaRoot, "lib/flutter"),
			fuchsiaRoot && path.join(fuchsiaRoot, "third_party/dart-pkg/git/flutter"),
			firstFlutterMobileProject,
			firstFlutterMobileProject && extractFlutterSdkPathFromPackagesFile(firstFlutterMobileProject),
			firstFlutterMobileProject && path.join(firstFlutterMobileProject, ".flutter"),
			firstFlutterMobileProject && path.join(firstFlutterMobileProject, "vendor/flutter"),
			process.env.FLUTTER_ROOT,
			isLinux ? "~/snap/flutter/common/flutter" : undefined,
			"~/flutter-sdk",
			"~/.flutter-sdk",
		].concat(paths).filter(notUndefined);

		let flutterSdkResult = this.findFlutterSdk(flutterSdkSearchPaths);

		// Handle the case where the Flutter snap has not been initialised.
		if (!flutterSdkResult.sdkPath && flutterSdkResult.candidatePaths.includes(snapBinaryPath)) {
			// Trigger initialization.
			this.logger.info(`No Flutter SDK found, but a 'flutter' binary did point at ${snapBinaryPath} so attempting to initialize...`);
			await initializeFlutterSdk(this.logger, snapFlutterBinaryPath);

			// Then search again.
			this.logger.info(`Snap initialization completed, searching for Flutter SDK again...`);
			flutterSdkResult = this.findFlutterSdk(flutterSdkSearchPaths);
		}

		const flutterSdkPath = flutterSdkResult.sdkPath;

		// Since we just blocked on a lot of sync FS, yield.
		await resolvedPromise;

		// If we're a Flutter workspace but we couldn't get the version, try running Flutter to initialise it first.
		// Do this before searching for the Dart SDK, as it might download the Dart SDK we'd like to find.
		if (hasAnyFlutterProject && flutterSdkPath) {
			const flutterNeedsInitializing = !getSdkVersion(this.logger, { sdkRoot: flutterSdkPath, versionFile: workspaceConfig?.flutterVersionFile })
				|| !fs.existsSync(path.join(flutterSdkPath, "bin/cache/dart-sdk"));

			if (flutterNeedsInitializing)
				await initializeFlutterSdk(this.logger, path.join(flutterSdkPath, flutterPath));
		}

		const dartSdkSearchPaths = [
			isMac ? workspaceConfig?.dartSdkHomeMac : workspaceConfig?.dartSdkHomeLinux,
			// TODO: These could move into processFuchsiaWorkspace and be set on the config?
			fuchsiaRoot && path.join(fuchsiaRoot, "topaz/tools/prebuilt-dart-sdk", `${dartPlatformName}-x64`),
			fuchsiaRoot && path.join(fuchsiaRoot, "third_party/dart/tools/sdks/dart-sdk"),
			fuchsiaRoot && path.join(fuchsiaRoot, "third_party/dart/tools/sdks", dartPlatformName, "dart-sdk"),
			fuchsiaRoot && path.join(fuchsiaRoot, "dart/tools/sdks", dartPlatformName, "dart-sdk"),
			firstFlutterMobileProject && flutterSdkPath && path.join(flutterSdkPath, "bin/cache/dart-sdk"),
			config.sdkPath,
		].concat(paths)
			// The above array only has the Flutter SDK	in the search path if we KNOW it's a flutter
			// project, however this doesn't cover the activating-to-run-flutter.createProject so
			// we need to always look in the flutter SDK, but only AFTER the users PATH so that
			// we don't prioritise it over any real Dart versions.
			.concat([flutterSdkPath && path.join(flutterSdkPath, "bin/cache/dart-sdk")])
			.filter(notUndefined);

		// Since we just blocked on a lot of sync FS, yield.
		await resolvedPromise;

		const dartSdkResult = this.findDartSdk(dartSdkSearchPaths);
		const dartSdkPath = dartSdkResult.sdkPath;

		// Since we just blocked on a lot of sync FS, yield.
		await resolvedPromise;

		return new WorkspaceContext(
			{
				dart: dartSdkPath,
				dartSdkIsFromFlutter: !!dartSdkPath && isDartSdkFromFlutter(dartSdkPath),
				dartVersion: getSdkVersion(this.logger, { sdkRoot: dartSdkPath }),
				flutter: flutterSdkPath,
				flutterVersion: getSdkVersion(this.logger, { sdkRoot: flutterSdkPath, versionFile: workspaceConfig?.flutterVersionFile }),
			} as Sdks,
			workspaceConfig,
			hasAnyFlutterMobileProject,
			hasAnyWebProject,
			hasAnyStandardDartProject,
			!!fuchsiaRoot && hasAnyStandardDartProject,
		);
	}

	private findDartSdk(folders: string[]) {
		return this.searchPaths(folders, executableNames.dart, (p) => this.hasExecutable(p, dartVMPath) && hasDartAnalysisServer(p));
	}

	private findFlutterSdk(folders: string[]) {
		return this.searchPaths(folders, executableNames.flutter, (p) => this.hasExecutable(p, flutterPath));
	}

	private hasExecutable(folder: string, executablePath: string) {
		const fullPath = path.join(folder, executablePath);
		return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
	}

	public searchPaths(paths: string[], executableFilename: string, postFilter?: (s: string) => boolean): SdkSearchResults {
		this.logger.info(`Searching for ${executableFilename}`);

		let sdkPaths =
			paths
				.filter((p) => p)
				.map(resolvePaths)
				.filter(notUndefined);

		// Any that don't end with bin, add it on (as an extra path) since some of our
		// paths may come from places that don't already include it (for ex. the
		// user config.sdkPath).
		const isBinFolder = (f: string) => ["bin", "sbin"].indexOf(path.basename(f)) !== -1;
		sdkPaths = flatMap(sdkPaths, (p) => isBinFolder(p) ? [p] : [p, path.join(p, "bin")]);

		// Add on the executable name, as we need to do filtering based on the resolve path.

		// TODO: Make the list unique, but preserve the order of the first occurrences. We currently
		// have uniq() and unique(), so also consolidate them.

		this.logger.info(`    Looking for ${executableFilename} in:`);
		for (const p of sdkPaths)
			this.logger.info(`        ${p}`);

		// Restrict only to the paths that have the executable.
		sdkPaths = sdkPaths.filter((p) => fs.existsSync(path.join(p, executableFilename)));

		this.logger.info(`    Found at:`);
		for (const p of sdkPaths)
			this.logger.info(`        ${p}`);

		// Convert all the paths to their resolved locations.
		sdkPaths = sdkPaths.map((p) => {
			const fullPath = path.join(p, executableFilename);

			// In order to handle symlinks on the binary (not folder), we need to add the executableName before calling realpath.
			const realExecutableLocation = p && fs.realpathSync(fullPath);

			if (realExecutableLocation.toLowerCase() !== fullPath.toLowerCase())
				this.logger.info(`Following symlink: ${fullPath} ==> ${realExecutableLocation}`);

			// If the symlink resolves to the Snap binary, it's not a real SDK
			// and we should return as-is rather than walk up two levels, as we
			// may want to use the presence of this to trigger initialisation.
			if (realExecutableLocation === snapBinaryPath) {
				return snapBinaryPath;
			}

			// Then we need to take the executable name and /bin back off
			return path.dirname(path.dirname(realExecutableLocation));
		});

		// Now apply any post-filters.
		this.logger.info("    Candidate paths to be post-filtered:");
		for (const p of sdkPaths)
			this.logger.info(`        ${p}`);
		const sdkPath = sdkPaths.find(postFilter || (() => true));

		if (sdkPath)
			this.logger.info(`    Found at ${sdkPath}`);


		this.logger.info(`    Returning SDK path ${sdkPath} for ${executableFilename}`);

		return { sdkPath, candidatePaths: sdkPaths };
	}
}

export function referencesFlutterSdk(folder?: string): boolean {
	if (folder && hasPubspec(folder)) {
		const regex = new RegExp("sdk\\s*:\\s*flutter", "i");
		return regex.test(fs.readFileSync(path.join(folder, "pubspec.yaml")).toString());
	}
	return false;
}

export function referencesBuildRunner(folder?: string): boolean {
	if (folder && hasPubspec(folder)) {
		const regex = new RegExp("build_runner\\s*:", "i");
		return regex.test(fs.readFileSync(path.join(folder, "pubspec.yaml")).toString());
	}
	return false;
}

function extractFlutterSdkPathFromPackagesFile(projectFolder: string): string | undefined {
	if (!fs.existsSync(projectFolder))
		return undefined;

	let packagePath = PackageMap.loadForProject(nullLogger, projectFolder).getPackagePath("flutter");

	if (!packagePath)
		return undefined;

	// Set windows slashes to / while manipulating.
	if (isWin) {
		packagePath = packagePath.replace(/\\/g, "/");
	}

	// Make sure ends with a slash.
	if (!packagePath.endsWith("/"))
		packagePath = packagePath + "/";

	// Trim suffix we don't need.
	const pathSuffix = "/packages/flutter/lib/";
	if (packagePath.endsWith(pathSuffix)) {
		packagePath = packagePath.substr(0, packagePath.length - pathSuffix.length);
	}

	// Make sure ends with a slash.
	if (!packagePath.endsWith("/"))
		packagePath = packagePath + "/";

	// Append bin if required.
	if (!packagePath.endsWith("/bin/")) {
		packagePath = packagePath + "bin/";
	}

	// Set windows paths back.
	if (isWin) {
		packagePath = packagePath.replace(/\//g, "\\");
		if (packagePath.startsWith("\\"))
			packagePath = packagePath.substring(1);
	}

	return packagePath;
}

async function findFuchsiaRoot(logger: Logger, folder: string): Promise<string | undefined> {
	return findRootContaining(folder, ".jiri_root");
}

async function findBazelWorkspaceRoot(logger: Logger, folder: string): Promise<string | undefined> {
	return findRootContaining(folder, "WORKSPACE", true);
}

async function findGitRoot(logger: Logger, folder: string): Promise<string | undefined> {
	return findRootContaining(folder, ".git");
}

function findRootContaining(folder: string, childName: string, expectFile = false): string | undefined {
	if (folder) {
		// Walk up the directories from the workspace root, and see if there
		// exists a directory which has `childName` file/directory as a child.
		let child = folder;
		while (child) {
			try {
				const stat = fs.statSync(path.join(child, childName));
				if (expectFile ? stat.isFile() : stat.isDirectory()) {
					return child;
				}
			} catch { }

			const parentDir = path.dirname(child);
			if (child === parentDir)
				break;

			child = parentDir;
		}
	}

	return undefined;
}

export const hasDartAnalysisServer = (folder: string) => fs.existsSync(path.join(folder, analyzerSnapshotPath));
