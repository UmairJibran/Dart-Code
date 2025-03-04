import * as assert from "assert";
import * as path from "path";
import * as vs from "vscode";
import { DebugProtocol } from "vscode-debugprotocol";
import { isLinux } from "../../../shared/constants";
import { DebuggerType, VmService, VmServiceExtension } from "../../../shared/enums";
import { versionIsAtLeast } from "../../../shared/utils";
import { grey, grey2 } from "../../../shared/utils/colors";
import { fsPath } from "../../../shared/utils/fs";
import { resolvedPromise } from "../../../shared/utils/promises";
import { DartDebugClient } from "../../dart_debug_client";
import { createDebugClient, ensureFrameCategories, ensureMapEntry, ensureNoVariable, ensureVariable, ensureVariableWithIndex, flutterTestDeviceId, flutterTestDeviceIsWeb, isExternalPackage, isLocalPackage, isSdkFrame, isUserCode, killFlutterTester, startDebugger, waitAllThrowIfTerminates } from "../../debug_helpers";
import { activate, defer, deferUntilLast, delay, extApi, flutterHelloWorldBrokenFile, flutterHelloWorldFolder, flutterHelloWorldGettersFile, flutterHelloWorldHttpFile, flutterHelloWorldLocalPackageFile, flutterHelloWorldMainFile, flutterHelloWorldStack60File, flutterHelloWorldThrowInExternalPackageFile, flutterHelloWorldThrowInLocalPackageFile, flutterHelloWorldThrowInSdkFile, getDefinition, getLaunchConfiguration, makeTrivialChangeToFileDirectly, openFile, positionOf, saveTrivialChangeToFile, sb, setConfigForTest, uriFor, waitForResult, watchPromise } from "../../helpers";

const deviceName = flutterTestDeviceIsWeb ? "Chrome" : "Flutter test device";

describe(`flutter run debugger (launch on ${flutterTestDeviceId})`, () => {
	beforeEach("activate flutterHelloWorldMainFile", () => activate(flutterHelloWorldMainFile));

	beforeEach("Skip if web device is not supported", function () {
		// TODO: Remove branch check when Flutter removes it.
		if (flutterTestDeviceIsWeb && (process.env.FLUTTER_VERSION === "stable" || process.env.FLUTTER_VERSION === "beta"))
			this.skip();
	});


	let dc: DartDebugClient;
	beforeEach("create debug client", () => {
		dc = createDebugClient(DebuggerType.Flutter);
	});

	beforeEach(() => {
		deferUntilLast(() => watchPromise("Killing flutter_tester processes", killFlutterTester()));
	});

	it("runs and remains active until told to quit", async () => {
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			dc.assertOutputContains("stdout", `Launching lib${path.sep}main.dart on ${deviceName} in debug mode...\n`),
			dc.configurationSequence(),
			dc.launch(config),
		);

		// Ensure we're still responsive after 3 seconds.
		await delay(3000);
		await dc.threadsRequest();

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	describe("prompts the user if trying to run with errors", () => {
		it("and cancels launch if they click Show Errors");
		it("and launches if they click Debug Anyway");
		it("unless the errors are in test scripts");
		it("in the test script being run");
	});

	it("expected debugger services/extensions are available in debug mode", async () => {
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence(),
			dc.launch(config),
		);

		await waitForResult(() => extApi.debugCommands.vmServices.serviceIsRegistered(VmService.HotRestart) === true);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceIsRegistered(VmService.HotReload) === true);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceExtensionIsLoaded(VmServiceExtension.DebugPaint) === true);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceExtensionIsLoaded(VmServiceExtension.DebugBanner) === true);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);

		await waitForResult(() => extApi.debugCommands.vmServices.serviceIsRegistered(VmService.HotRestart) === false);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceIsRegistered(VmService.HotReload) === false);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceExtensionIsLoaded(VmServiceExtension.DebugPaint) === false);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceExtensionIsLoaded(VmServiceExtension.DebugBanner) === false);
	});

	it("expected debugger services/extensions are available in noDebug mode", async () => {
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		config.noDebug = true;
		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence(),
			dc.launch(config),
		);

		await waitForResult(() => extApi.debugCommands.vmServices.serviceIsRegistered(VmService.HotRestart) === true);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceIsRegistered(VmService.HotReload) === true);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceExtensionIsLoaded(VmServiceExtension.DebugPaint) === true);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceExtensionIsLoaded(VmServiceExtension.DebugBanner) === true);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);

		await waitForResult(() => extApi.debugCommands.vmServices.serviceIsRegistered(VmService.HotRestart) === false);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceIsRegistered(VmService.HotReload) === false);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceExtensionIsLoaded(VmServiceExtension.DebugPaint) === false);
		await waitForResult(() => extApi.debugCommands.vmServices.serviceExtensionIsLoaded(VmServiceExtension.DebugBanner) === false);
	});

	it("can quit during a build", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		// Kick off a build, but do not await it...
		// tslint:disable-next-line: no-floating-promises
		Promise.all([
			dc.configurationSequence(),
			dc.launch(config),
		]);

		// Wait 5 seconds to ensure the build is in progress...
		await delay(5000);

		// Send a disconnect request and ensure it happens within 5 seconds.
		await Promise.race([
			Promise.all([
				dc.waitForEvent("terminated"),
				dc.terminateRequest(),
			]),
			new Promise((resolve, reject) => setTimeout(() => reject(new Error("Did not complete terminateRequest within 5s")), 5000)),
		]);
	});

	it("receives the expected output", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence(),
			dc.assertOutputContains("stdout", "Hello, world!"),
			dc.assertOutputContains("console", "Logging from dart:developer!"),
			dc.assertOutputContains("console", "<<end_of_long_line>>"),
			dc.launch(config),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("resolves relative paths", async () => {
		const config = await getLaunchConfiguration(
			path.relative(fsPath(flutterHelloWorldFolder), fsPath(flutterHelloWorldMainFile)),
			{ deviceId: flutterTestDeviceId },
		);
		assert.equal(config!.program, fsPath(flutterHelloWorldMainFile));
	});

	it("can hot reload with customRequest", async () => {
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			watchPromise("hot_reloads_successfully->configurationSequence", dc.configurationSequence()),
			watchPromise("hot_reloads_successfully->launch", dc.launch(config)),
		);

		await watchPromise("hot_reloads_successfully->hotReload", dc.hotReload());

		await waitAllThrowIfTerminates(dc,
			watchPromise("hot_reloads_successfully->waitForEvent:terminated", dc.waitForEvent("terminated")),
			watchPromise("hot_reloads_successfully->terminateRequest", dc.terminateRequest()),
		);
	});

	it("can hot reload using command", async function () {
		if (flutterTestDeviceIsWeb && !extApi.flutterCapabilities.webSupportsHotReload)
			return this.skip();

		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			watchPromise("hot_reloads_successfully->configurationSequence", dc.configurationSequence()),
			watchPromise("hot_reloads_successfully->launch", dc.launch(config)),
		);

		await vs.commands.executeCommand("flutter.hotReload");

		await waitAllThrowIfTerminates(dc,
			watchPromise("hot_reloads_successfully->waitForEvent:terminated", dc.waitForEvent("terminated")),
			watchPromise("hot_reloads_successfully->terminateRequest", dc.terminateRequest()),
		);
	});

	it("hot reloads on save", async () => {
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence(),
			dc.launch(config),
		);

		// If we go too fast, things fail..
		await delay(500);

		await waitAllThrowIfTerminates(dc,
			dc.waitForHotReload(),
			saveTrivialChangeToFile(flutterHelloWorldMainFile),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("hot reloads on external modification of file", async () => {
		await setConfigForTest("dart", "previewHotReloadOnSaveWatcher", true);
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence(),
			dc.launch(config),
		);

		// If we go too fast, things fail..
		await delay(500);

		await waitAllThrowIfTerminates(dc,
			dc.waitForHotReload(),
			makeTrivialChangeToFileDirectly(flutterHelloWorldMainFile),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("can hot restart using customRequest", async () => {
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence(),
			dc.launch(config),
		);

		// If we restart too fast, things fail :-/
		await delay(1000);

		await waitAllThrowIfTerminates(dc,
			dc.assertOutputContains("stdout", "Restarted app"),
			dc.customRequest("hotRestart"),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("can hot restart using command", async () => {
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence(),
			dc.launch(config),
		);

		// If we restart too fast, things fail :-/
		await delay(1000);

		await waitAllThrowIfTerminates(dc,
			dc.assertOutputContains("stdout", "Restarted app"),
			vs.commands.executeCommand("flutter.hotRestart") as Promise<void>,
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("automatically spawns DevTools at startup", async function () {
		if (!extApi.flutterCapabilities.supportsDevToolsServerAddress)
			this.skip();

		assert.ok(extApi.debugCommands.devTools.devtoolsUrl);
		assert.ok((await extApi.debugCommands.devTools.devtoolsUrl).startsWith("http://"));
	});

	it("can launch DevTools externally", async () => {
		await setConfigForTest("dart", "embedDevTools", false);

		const openBrowserCommand = sb.stub(extApi.envUtils, "openInBrowser").resolves();

		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await waitAllThrowIfTerminates(dc,
			dc.assertOutputContains("stdout", `Launching lib${path.sep}main.dart on ${deviceName} in debug mode...\n`),
			dc.configurationSequence(),
			dc.launch(config),
		);

		const devTools = await vs.commands.executeCommand("dart.openDevTools") as { url: string, dispose: () => void };
		assert.ok(openBrowserCommand.calledOnce);
		assert.ok(devTools);
		defer(devTools.dispose);
		assert.ok(devTools.url);

		const serverResponse = await extApi.webClient.fetch(devTools.url);
		assert.notEqual(serverResponse.indexOf("Dart DevTools"), -1);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	const numReloads = 1;
	it(`stops at a breakpoint after each reload (${numReloads})`, async () => {
		await openFile(flutterHelloWorldMainFile);
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		const expectedLocation = {
			line: positionOf("^// BREAKPOINT1").line, // positionOf is 0-based, and seems to want 1-based, BUT comment is on next line!
			path: fsPath(flutterHelloWorldMainFile),
		};
		await watchPromise("stops_at_a_breakpoint->hitBreakpoint", dc.hitBreakpoint(config, expectedLocation));
		const stack = await dc.getStack();
		const frames = stack.body.stackFrames;
		// Web/Flutter have slightly different representations of this
		// so allow either.
		if (frames[0].name.indexOf(".") !== -1)
			assert.equal(frames[0].name, "MyHomePage.build");
		else
			assert.equal(frames[0].name, "build");
		assert.equal(frames[0].source!.path, expectedLocation.path);
		assert.equal(frames[0].source!.name, "package:flutter_hello_world/main.dart");

		await watchPromise("stops_at_a_breakpoint->resume", dc.resume());

		// Add some invalid breakpoints because in the past they've caused us issues
		// https://github.com/Dart-Code/Dart-Code/issues/1437.
		// We need to also include expectedLocation since this overwrites all BPs.
		await dc.setBreakpointsRequest({
			breakpoints: [{ line: 0 }, expectedLocation],
			source: { path: fsPath(flutterHelloWorldMainFile) },
		});

		// Reload and ensure we hit the breakpoint on each one.
		for (let i = 0; i < numReloads; i++) {
			await delay(2000); // TODO: Remove this attempt to see if reloading too fast is causing our flakes...
			await waitAllThrowIfTerminates(dc,
				watchPromise(`stops_at_a_breakpoint->reload:${i}->assertStoppedLocation:breakpoint`, dc.assertStoppedLocation("breakpoint", expectedLocation))
					.then(async () => {
						const stack = await watchPromise(`stops_at_a_breakpoint->reload:${i}->getStack`, dc.getStack());
						const frames = stack.body.stackFrames;
						// Web/Flutter have slightly different representations of this
						// so allow either.
						if (frames[0].name.indexOf(".") !== -1)
							assert.equal(frames[0].name, "MyHomePage.build");
						else
							assert.equal(frames[0].name, "build");
						assert.equal(frames[0].source!.path, expectedLocation.path);
						assert.equal(frames[0].source!.name, "package:flutter_hello_world/main.dart");
					})
					.then(() => watchPromise(`stops_at_a_breakpoint->reload:${i}->resume`, dc.resume())),
				watchPromise(`stops_at_a_breakpoint->reload:${i}->hotReload:breakpoint`, dc.hotReload()),
			);
		}

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("does not stop at a breakpoint in noDebug mode", async () => {
		await openFile(flutterHelloWorldMainFile);
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		config.noDebug = true;

		let didStop = false;

		dc.waitForEvent("stopped")
			.then(() => didStop = true)
			.catch(() => {
				// Swallow errors, as we don't care if this times out, we're only using it
				// to tell if we stopped by the time we hit the end of this test.
			});
		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.setBreakpointWithoutHitting(config, {
				line: positionOf("^// BREAKPOINT1").line + 1, // positionOf is 0-based, but seems to want 1-based
				path: fsPath(flutterHelloWorldMainFile),
				verified: false,
			})
				.then(() => delay(20000))
				.then(() => dc.terminateRequest()),
		);

		assert.equal(didStop, false);
	});

	it("stops at a breakpoint in a part file");

	it("stops at a breakpoint in a deferred file");

	// Known not to work; https://github.com/Dart-Code/Dart-Code/issues/821
	it.skip("stops at a breakpoint in the SDK");

	it("stops at a breakpoint in an external package");

	it("steps into the SDK if debugSdkLibraries is true", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldMainFile);
		// Get location for `print`
		const printCall = positionOf("pri^nt(");
		const config = await startDebugger(dc, flutterHelloWorldMainFile, { debugSdkLibraries: true });
		await dc.hitBreakpoint(config, {
			line: printCall.line + 1,
			path: fsPath(flutterHelloWorldMainFile),
		});
		await waitAllThrowIfTerminates(dc,
			dc.assertStoppedLocation("step", {
				// SDK source will have no filename, because we download it
				path: undefined,
			}).then((response) => {
				// Ensure the top stack frame matches
				const frame = response.body.stackFrames[0];
				assert.equal(frame.name, "print");
				// We don't get a source path, because the source is downloaded from the VM
				assert.equal(frame.source!.path, undefined);
				assert.equal(frame.source!.name, "dart:core/print.dart");
			}),
			dc.stepIn(),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("does not step into the SDK if debugSdkLibraries is false", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldMainFile);
		// Get location for `print`
		const printCall = positionOf("pri^nt(");
		const config = await startDebugger(dc, flutterHelloWorldMainFile, { debugSdkLibraries: false });
		await dc.hitBreakpoint(config, {
			line: printCall.line + 1,
			path: fsPath(flutterHelloWorldMainFile),
		});
		await waitAllThrowIfTerminates(dc,
			dc.assertStoppedLocation("step", {
				// Ensure we stayed in the current file
				path: fsPath(flutterHelloWorldMainFile),
			}),
			dc.stepIn(),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("steps into an external library if debugExternalLibraries is true", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldHttpFile);
		// Get location for `http.read(`
		const httpReadCall = positionOf("http.re^ad(");
		const httpReadDef = await getDefinition(httpReadCall);
		const config = await startDebugger(dc, flutterHelloWorldHttpFile, { debugExternalLibraries: true });
		await dc.hitBreakpoint(config, {
			line: httpReadCall.line + 1,
			path: fsPath(flutterHelloWorldHttpFile),
		});
		await waitAllThrowIfTerminates(dc,
			dc.assertStoppedLocation("step", {
				// Ensure we stepped into the external file
				path: fsPath(uriFor(httpReadDef)),
			}).then((response) => {
				// Ensure the top stack frame matches
				const frame = response.body.stackFrames[0];
				assert.equal(frame.name, "read");
				assert.equal(frame.source!.path, fsPath(uriFor(httpReadDef)));
				assert.equal(frame.source!.name, "package:http/http.dart");
			}),
			dc.stepIn(),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("does not step into an external library if debugExternalLibraries is false", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldHttpFile);
		// Get location for `http.read(`
		const httpReadCall = positionOf("http.re^ad(");
		const config = await startDebugger(dc, flutterHelloWorldHttpFile, { debugExternalLibraries: false });
		await dc.hitBreakpoint(config, {
			line: httpReadCall.line,
			path: fsPath(flutterHelloWorldHttpFile),
		});
		await waitAllThrowIfTerminates(dc,
			dc.assertStoppedLocation("step", {
				// Ensure we stayed in the current file
				path: fsPath(flutterHelloWorldHttpFile),
			}),
			dc.stepIn(),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("steps into a local library even if debugExternalLibraries is false", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldLocalPackageFile);
		// Get location for `printMyThing()`
		const printMyThingCall = positionOf("printMy^Thing(");
		const printMyThingDef = await getDefinition(printMyThingCall);
		const config = await startDebugger(dc, flutterHelloWorldLocalPackageFile, { debugExternalLibraries: false });
		await dc.hitBreakpoint(config, {
			line: printMyThingCall.line + 1,
			path: fsPath(flutterHelloWorldLocalPackageFile),
		});
		await waitAllThrowIfTerminates(dc,
			dc.assertStoppedLocation("step", {
				// Ensure we stepped into the external file
				path: fsPath(uriFor(printMyThingDef)),
			}).then((response) => {
				// Ensure the top stack frame matches
				const frame = response.body.stackFrames[0];
				assert.equal(frame.name, "printMyThing");
				assert.equal(frame.source!.path, fsPath(uriFor(printMyThingDef)));
				assert.equal(frame.source!.name, "package:my_package/my_thing.dart");
			}),
			dc.stepIn(),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("downloads SDK source code from the VM");

	it("correctly marks non-debuggable SDK frames when debugSdkLibraries is false", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldThrowInSdkFile);
		const config = await startDebugger(dc, flutterHelloWorldThrowInSdkFile, { debugSdkLibraries: false });
		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("initialized")
				.then(() => dc.setExceptionBreakpointsRequest({ filters: ["All"] }))
				.then(() => dc.configurationDoneRequest()),
			dc.waitForEvent("stopped"),
			dc.launch(config),
		);
		const stack = await dc.getStack();
		ensureFrameCategories(stack.body.stackFrames.filter(isSdkFrame), "deemphasize", "from the Dart SDK");
		ensureFrameCategories(stack.body.stackFrames.filter(isUserCode), undefined, undefined);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("correctly marks debuggable SDK frames when debugSdkLibraries is true", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldThrowInSdkFile);
		const config = await startDebugger(dc, flutterHelloWorldThrowInSdkFile, { debugSdkLibraries: true });
		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("initialized")
				.then(() => dc.setExceptionBreakpointsRequest({ filters: ["All"] }))
				.then(() => dc.configurationDoneRequest()),
			dc.waitForEvent("stopped"),
			dc.launch(config),
		);
		const stack = await dc.getStack();
		ensureFrameCategories(stack.body.stackFrames.filter(isSdkFrame), undefined, undefined);
		ensureFrameCategories(stack.body.stackFrames.filter(isUserCode), undefined, undefined);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("correctly marks non-debuggable external library frames when debugExternalLibraries is false", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldThrowInExternalPackageFile);
		const config = await startDebugger(dc, flutterHelloWorldThrowInExternalPackageFile, { debugExternalLibraries: false });
		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("initialized")
				.then(() => dc.setExceptionBreakpointsRequest({ filters: ["All"] }))
				.then(() => dc.configurationDoneRequest()),
			dc.waitForEvent("stopped"),
			dc.launch(config),
		);
		const stack = await dc.getStack();
		ensureFrameCategories(stack.body.stackFrames.filter(isExternalPackage), "deemphasize", "from Pub packages");
		ensureFrameCategories(stack.body.stackFrames.filter(isUserCode), undefined, undefined);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("correctly marks debuggable external library frames when debugExternalLibraries is true", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldThrowInExternalPackageFile);
		const config = await startDebugger(dc, flutterHelloWorldThrowInExternalPackageFile, { debugExternalLibraries: true });
		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("initialized")
				.then(() => dc.setExceptionBreakpointsRequest({ filters: ["All"] }))
				.then(() => dc.configurationDoneRequest()),
			dc.waitForEvent("stopped"),
			dc.launch(config),
		);
		const stack = await dc.getStack();
		ensureFrameCategories(stack.body.stackFrames.filter(isExternalPackage), undefined, undefined);
		ensureFrameCategories(stack.body.stackFrames.filter(isUserCode), undefined, undefined);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("correctly marks debuggable local library frames even when debugExternalLibraries is false", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldThrowInLocalPackageFile);
		const config = await startDebugger(dc, flutterHelloWorldThrowInLocalPackageFile, { debugExternalLibraries: false });
		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("initialized")
				.then(() => dc.setExceptionBreakpointsRequest({ filters: ["All"] }))
				.then(() => dc.configurationDoneRequest()),
			dc.waitForEvent("stopped"),
			dc.launch(config),
		);
		const stack = await dc.getStack();
		ensureFrameCategories(stack.body.stackFrames.filter(isLocalPackage), undefined, undefined);
		ensureFrameCategories(stack.body.stackFrames.filter(isUserCode), undefined, undefined);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("can fetch slices of stack frames", async () => {
		// TODO: This might be unreliable until dev channel gets this.
		const expectFullCount = !versionIsAtLeast(extApi.dartCapabilities.version, "2.12.0-0");

		await openFile(flutterHelloWorldStack60File);
		const config = await startDebugger(dc, flutterHelloWorldStack60File);
		await dc.hitBreakpoint(config, {
			line: positionOf("^// BREAKPOINT1").line + 1,
			path: fsPath(flutterHelloWorldStack60File),
		});

		// Get the total stack size we should expect and ensure it's a little over the expected current 560
		// (don't hard-code the exact value as it may change with SDK releases).
		const fullStack = await dc.getStack(0, 10000);
		const fullStackFrameCount = fullStack.body.totalFrames ?? 0;
		const expectedMin = 400;
		const expectedMax = 1000;
		assert.ok(
			fullStackFrameCount >= expectedMin && fullStackFrameCount <= expectedMax,
			`Expected ${expectedMin}-${expectedMax} frames but got ${fullStackFrameCount}:
			${fullStack.body.stackFrames.map((f, i) => `   ${i}: ${f.name}`).join("\n")}`,
		);

		const stack1 = await dc.getStack(0, 1); // frame 0
		const stack2 = await dc.getStack(1, 9); // frame 1-10
		const stack3 = await dc.getStack(10, 10); // frame 10-19
		const stack4 = await dc.getStack(20, 1000); // rest
		assert.strictEqual(stack1.body.stackFrames.length, 1);
		// For the first frame, we'll always get 1 + batchSize because we may short-cut going to the VM.
		assert.strictEqual(stack1.body.totalFrames, 21); // Expect n + 20
		assert.strictEqual(stack2.body.stackFrames.length, 9);
		assert.strictEqual(stack2.body.totalFrames, expectFullCount ? fullStackFrameCount : 30); // offset+length+20
		assert.strictEqual(stack3.body.stackFrames.length, 10);
		assert.strictEqual(stack3.body.totalFrames, expectFullCount ? fullStackFrameCount : 40); // offset+length+20
		assert.strictEqual(stack4.body.stackFrames.length, fullStackFrameCount - 20); // Full minus the 20 already fetched.
		assert.strictEqual(stack4.body.totalFrames, fullStackFrameCount); // Always expect full count for rest
		const frameNames = [
			...stack1.body.stackFrames,
			...stack2.body.stackFrames,
			...stack3.body.stackFrames,
			...stack4.body.stackFrames,
		]
			.map((f) => f.name);
		// The top 60 frames should be from func60 down to func1.
		// For Flutter web, each frame appears twice, so handle that for now while waiting to hear
		// if that's expected.
		const frameMultiplier = frameNames[0] === frameNames[1] ? 2 : 1;
		for (let i = 0; i < 60; i++)
			assert.strictEqual(frameNames[i * frameMultiplier], `func${60 - i}`);
	});

	function testBreakpointCondition(condition: string, shouldStop: boolean, expectedError?: string) {
		return async () => {
			await openFile(flutterHelloWorldMainFile);
			const config = await startDebugger(dc, flutterHelloWorldMainFile);

			let didStop = false;

			dc.waitForEvent("stopped")
				.then(() => didStop = true)
				.catch(() => {
					// Swallow errors, as we don't care if this times out, we're only using it
					// to tell if we stopped by the time we hit the end of this test.
				});

			let expectation: Promise<any> = resolvedPromise;
			if (shouldStop)
				expectation = expectation.then(() => dc.waitForEvent("stopped"));

			if (expectedError)
				expectation = expectation.then(() => dc.assertOutputContains("console", expectedError));

			// If we don't have another expectation, then we need to keep running for some period
			// after launch to ensure we didn't stop unexpectedly.
			if (expectation === resolvedPromise)
				// This may be too low for web.
				expectation = dc.waitForEvent("initialized").then(() => delay(20000));

			await waitAllThrowIfTerminates(dc,
				dc.waitForEvent("terminated"),
				dc.waitForEvent("initialized")
					.then(() => dc.setBreakpointsRequest({
						// positionOf is 0-based, but seems to want 1-based
						breakpoints: [{
							condition,
							line: positionOf("^// BREAKPOINT1").line,
						}],
						source: { path: fsPath(flutterHelloWorldMainFile) },
					}))
					.then(() => dc.configurationDoneRequest()),
				expectation.then(() => dc.terminateRequest()),
				dc.launch(config),
			);

			assert.equal(didStop, shouldStop);
		};
	}

	it("stops at a breakpoint with a condition returning true", testBreakpointCondition("1 == 1", true));
	it("stops at a breakpoint with a condition returning 1", testBreakpointCondition("3 - 2", true));
	it("does not stop at a breakpoint with a condition returning a string", testBreakpointCondition("'test'", false));
	it("does not stop at a breakpoint with a condition returning false", testBreakpointCondition("1 == 0", false));
	it("does not stop at a breakpoint with a condition returning 0", testBreakpointCondition("3 - 3", false));
	it("does not stop at a breakpoint with a condition returning null", testBreakpointCondition("print('test');", false));
	it("reports errors evaluating breakpoint conditions", testBreakpointCondition("1 + '1'", false, "Debugger failed to evaluate expression `1 + '1'`"));

	it("logs expected text (and does not stop) at a logpoint", async () => {
		await openFile(flutterHelloWorldMainFile);
		const config = await startDebugger(dc, flutterHelloWorldMainFile);

		let didStop = false;

		dc.waitForEvent("stopped")
			.then(() => didStop = true)
			.catch(() => {
				// Swallow errors, as we don't care if this times out, we're only using it
				// to tell if we stopped by the time we hit the end of this test.
			});

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("initialized")
				.then(() => dc.setBreakpointsRequest({
					breakpoints: [{
						line: positionOf("^// BREAKPOINT1").line,
						// VS Code says to use {} for expressions, but we want to support Dart's native too, so
						// we have examples of both (as well as "escaped" brackets).
						logMessage: '${s} The \\{year} is """{(new DateTime.now()).year}"""',
					}],
					source: { path: fsPath(flutterHelloWorldMainFile) },
				}))
				.then(() => dc.configurationDoneRequest()),
			dc.assertOutputContains("stdout", `Hello! The {year} is """${(new Date()).getFullYear()}"""\n`)
				.then(() => delay(2000))
				.then(() => dc.terminateRequest()),
			dc.waitForEvent("terminated"),
			dc.launch(config),
		);

		assert.equal(didStop, false);
	});

	it("provides local variables when stopped at a breakpoint", async () => {
		await openFile(flutterHelloWorldMainFile);
		const debugConfig = await startDebugger(dc, flutterHelloWorldMainFile);
		await dc.hitBreakpoint(debugConfig, {
			line: positionOf("^// BREAKPOINT1").line,
			path: fsPath(flutterHelloWorldMainFile),
		});

		const variables = await dc.getTopFrameVariables("Locals");
		ensureVariable(variables, "l", "l", `List (12 items)`);
		ensureVariable(variables, "longStrings", "longStrings", `List (1 item)`);
		ensureVariable(variables, "tenDates", "tenDates", `List (10 items)`);
		ensureVariable(variables, "hundredDates", "hundredDates", `List (100 items)`);
		ensureVariable(variables, "s", "s", `"Hello!"`);
		ensureVariable(variables, "m", "m", `Map (10 items)`);

		const listVariables = await dc.getVariables(variables.find((v) => v.name === "l")!.variablesReference);
		for (let i = 0; i <= 1; i++) {
			ensureVariableWithIndex(listVariables, i, `l[${i}]`, `[${i}]`, `${i}`);
		}

		// TODO: Remove this condition when web truncates variables
		if (!flutterTestDeviceIsWeb) {
			const longStringListVariables = await dc.getVariables(variables.find((v) => v.name === "longStrings")!.variablesReference);
			ensureVariable(longStringListVariables, "longStrings[0]", "[0]", {
				ends: "…\"", // String is truncated here.
				starts: "\"This is a long string that is 300 characters!",
			});
		} else {
			console.warn(`Skipping long string check for Chrome...`);
		}

		const shortdateListVariables = await dc.getVariables(variables.find((v) => v.name === "tenDates")!.variablesReference);
		ensureVariable(shortdateListVariables, "tenDates[0]", "[0]", "DateTime (2005-01-01 00:00:00.000)");

		const mapVariables = await dc.getVariables(variables.find((v) => v.name === "m")!.variablesReference);
		ensureVariable(mapVariables, undefined, "0", `"l" -> List (12 items)`);
		ensureVariable(mapVariables, undefined, "1", `"longStrings" -> List (1 item)`);
		ensureVariable(mapVariables, undefined, "2", `"tenDates" -> List (10 items)`);
		ensureVariable(mapVariables, undefined, "3", `"hundredDates" -> List (100 items)`);
		ensureVariable(mapVariables, undefined, "4", `"s" -> "Hello!"`);
		ensureVariable(mapVariables, undefined, "5", `DateTime -> "valentines-2000"`);
		ensureVariable(mapVariables, undefined, "6", `DateTime -> "new-year-2005"`);
		ensureVariable(mapVariables, undefined, "7", `true -> true`);
		ensureVariable(mapVariables, undefined, "8", `1 -> "one"`);
		ensureVariable(mapVariables, undefined, "9", `1.1 -> "one-point-one"`);

		await ensureMapEntry(mapVariables, {
			key: { evaluateName: undefined, name: "key", value: `"l"` },
			value: { evaluateName: `m["l"]`, name: "value", value: "List (12 items)" },
		}, dc);
		await ensureMapEntry(mapVariables, {
			key: { evaluateName: undefined, name: "key", value: `"longStrings"` },
			value: { evaluateName: `m["longStrings"]`, name: "value", value: "List (1 item)" },
		}, dc);
		await ensureMapEntry(mapVariables, {
			key: { evaluateName: undefined, name: "key", value: `"s"` },
			value: { evaluateName: `m["s"]`, name: "value", value: `"Hello!"` },
		}, dc);
		await ensureMapEntry(mapVariables, {
			key: { evaluateName: undefined, name: "key", value: `DateTime (2000-02-14 00:00:00.000)` },
			value: { evaluateName: undefined, name: "value", value: `"valentines-2000"` },
		}, dc);
		await ensureMapEntry(mapVariables, {
			key: { evaluateName: undefined, name: "key", value: `DateTime (2005-01-01 00:00:00.000)` },
			value: { evaluateName: undefined, name: "value", value: `"new-year-2005"` },
		}, dc);
		await ensureMapEntry(mapVariables, {
			key: { evaluateName: undefined, name: "key", value: "true" },
			value: { evaluateName: `m[true]`, name: "value", value: "true" },
		}, dc);
		await ensureMapEntry(mapVariables, {
			key: { evaluateName: undefined, name: "key", value: "1" },
			value: { evaluateName: `m[1]`, name: "value", value: `"one"` },
		}, dc);
		await ensureMapEntry(mapVariables, {
			key: { evaluateName: undefined, name: "key", value: "1.1" },
			value: { evaluateName: `m[1.1]`, name: "value", value: `"one-point-one"` },
		}, dc);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("excludes type args from local variables when stopped at a breakpoint in a generic method", async () => {
		await openFile(flutterHelloWorldMainFile);
		const debugConfig = await startDebugger(dc, flutterHelloWorldMainFile);
		await dc.hitBreakpoint(debugConfig, {
			line: positionOf("^// BREAKPOINT2").line, // positionOf is 0-based, but seems to want 1-based
			path: fsPath(flutterHelloWorldMainFile),
		});

		const variables = await dc.getTopFrameVariables("Locals");
		ensureVariable(variables, "a", "a", `1`);
		// Ensure there were no others.
		assert.equal(variables.length, 1);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("includes fields and getters in variables when stopped at a breakpoint", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldGettersFile);
		const config = await startDebugger(dc, flutterHelloWorldGettersFile);
		await dc.hitBreakpoint(config, {
			line: positionOf("^// BREAKPOINT1").line + 1, // positionOf is 0-based, but seems to want 1-based
			path: fsPath(flutterHelloWorldGettersFile),
		});

		const variables = await dc.getTopFrameVariables("Locals");
		ensureVariable(variables, "danny", "danny", `Danny`);

		const classInstance = await dc.getVariables(variables.find((v) => v.name === "danny")!.variablesReference);
		// Fields
		ensureVariable(classInstance, "danny.field", "field", `"field"`);
		ensureVariable(classInstance, "danny.baseField", "baseField", `"baseField"`);
		// Getters
		ensureVariable(classInstance, "danny.kind", "kind", `"Person"`);
		// TODO: Remove this Linux-skip when this bug is fixed:
		// https://github.com/dart-lang/sdk/issues/39330
		if (!isLinux)
			ensureVariable(classInstance, "danny.name", "name", `"Danny"`);
		ensureVariable(classInstance, undefined, "throws", { starts: "Unhandled exception:\nOops!" });

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("includes fields but not getters in variables when evaluateGettersInDebugViews=false", async function () {
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await setConfigForTest("dart", "evaluateGettersInDebugViews", false);

		await openFile(flutterHelloWorldGettersFile);
		const config = await startDebugger(dc, flutterHelloWorldGettersFile);
		await dc.hitBreakpoint(config, {
			line: positionOf("^// BREAKPOINT1").line + 1, // positionOf is 0-based, but seems to want 1-based
			path: fsPath(flutterHelloWorldGettersFile),
		});

		const variables = await dc.getTopFrameVariables("Locals");
		ensureVariable(variables, "danny", "danny", `Danny`);

		const classInstance = await dc.getVariables(variables.find((v) => v.name === "danny")!.variablesReference);
		// Fields
		ensureVariable(classInstance, "danny.field", "field", `"field"`);
		ensureVariable(classInstance, "danny.baseField", "baseField", `"baseField"`);
		// No getters
		ensureNoVariable(classInstance, "kind");
		ensureNoVariable(classInstance, "name");
		ensureNoVariable(classInstance, "throws");

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	// Currently skipped because we sometimes get different text from locals, eg.:
	// "StatelessElement" vs "StatelessElement (MyHomepage(dirty))" 🤔
	it.skip("watch expressions provide same info as locals", async () => {
		await openFile(flutterHelloWorldMainFile);
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await dc.hitBreakpoint(config, {
			line: positionOf("^// BREAKPOINT1").line,
			path: fsPath(flutterHelloWorldMainFile),
		});

		const variables = await dc.getTopFrameVariables("Locals");

		for (const variable of variables) {
			const evaluateName = (variable as any).evaluateName;
			if (!evaluateName)
				continue;
			const evaluateResult = await dc.evaluateForFrame(evaluateName);
			assert.ok(evaluateResult);
			assert.equal(evaluateResult.result, variable.value);
			assert.equal(!!evaluateResult.variablesReference, !!variable.variablesReference);
		}

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("evaluateName evaluates to the expected value", async () => {
		await openFile(flutterHelloWorldMainFile);
		const config = await startDebugger(dc, flutterHelloWorldMainFile);
		await dc.hitBreakpoint(config, {
			line: positionOf("^// BREAKPOINT1").line,
			path: fsPath(flutterHelloWorldMainFile),
		});

		const variables = await dc.getTopFrameVariables("Locals");
		const listVariables = await dc.getVariables(variables.find((v) => v.name === "l")!.variablesReference);
		const listLongstringVariables = await dc.getVariables(variables.find((v) => v.name === "longStrings")!.variablesReference);
		const mapVariables = await dc.getVariables(variables.find((v) => v.name === "m")!.variablesReference);
		const allVariables = listVariables.concat(listLongstringVariables).concat(mapVariables);

		for (const variable of allVariables) {
			const evaluateName = (variable as any).evaluateName;
			if (!evaluateName)
				continue;
			const evaluateResult = await dc.evaluateForFrame(evaluateName);
			assert.ok(evaluateResult);
			if (variable.value.endsWith("…\"")) {
				// If the value was truncated, the evaluate responses should be longer
				const prefix = variable.value.slice(1, -2);
				assert.ok(evaluateResult.result.length > prefix.length);
				assert.equal(evaluateResult.result.slice(0, prefix.length), prefix);
			} else {
				// Otherwise it should be the same.
				assert.equal(evaluateResult.result, variable.value);
			}
			assert.equal(!!evaluateResult.variablesReference, !!variable.variablesReference);
		}

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	describe("can evaluate at breakpoint", () => {
		it("simple expressions", async () => {
			await openFile(flutterHelloWorldMainFile);
			const config = await startDebugger(dc, flutterHelloWorldMainFile);
			await waitAllThrowIfTerminates(dc,
				dc.hitBreakpoint(config, {
					line: positionOf("^// BREAKPOINT1").line,
					path: fsPath(flutterHelloWorldMainFile),
				}),
			);

			const evaluateResult = await dc.evaluateForFrame(`"test"`);
			assert.ok(evaluateResult);
			assert.equal(evaluateResult.result, `"test"`);
			assert.equal(evaluateResult.variablesReference, 0);

			await waitAllThrowIfTerminates(dc,
				dc.waitForEvent("terminated"),
				dc.terminateRequest(),
			);
		});

		it("complex expression expressions", async () => {
			await openFile(flutterHelloWorldMainFile);
			const config = await startDebugger(dc, flutterHelloWorldMainFile);
			await waitAllThrowIfTerminates(dc,
				dc.hitBreakpoint(config, {
					line: positionOf("^// BREAKPOINT1").line,
					path: fsPath(flutterHelloWorldMainFile),
				}),
			);

			const evaluateResult = await dc.evaluateForFrame(`(new DateTime.now()).year`);
			assert.ok(evaluateResult);
			assert.equal(evaluateResult.result, (new Date()).getFullYear());
			assert.equal(evaluateResult.variablesReference, 0);

			await waitAllThrowIfTerminates(dc,
				dc.waitForEvent("terminated"),
				dc.terminateRequest(),
			);
		});

		it("an expression that returns a variable", async () => {
			await openFile(flutterHelloWorldMainFile);
			const config = await startDebugger(dc, flutterHelloWorldMainFile);
			await waitAllThrowIfTerminates(dc,
				dc.hitBreakpoint(config, {
					line: positionOf("^// BREAKPOINT1").line,
					path: fsPath(flutterHelloWorldMainFile),
				}),
			);

			const evaluateResult = await dc.evaluateForFrame(`new DateTime.now()`);
			const thisYear = new Date().getFullYear().toString();
			assert.ok(evaluateResult);
			assert.ok(evaluateResult.result.startsWith("DateTime (" + thisYear), `Result '${evaluateResult.result}' did not start with ${thisYear}`);
			assert.ok(evaluateResult.variablesReference);

			await waitAllThrowIfTerminates(dc,
				dc.waitForEvent("terminated"),
				dc.terminateRequest(),
			);
		});

		it("complex expression expressions when in a top level function", async () => {
			await openFile(flutterHelloWorldMainFile);
			const config = await startDebugger(dc, flutterHelloWorldMainFile);
			await waitAllThrowIfTerminates(dc,
				dc.hitBreakpoint(config, {
					line: positionOf("^// BREAKPOINT2").line,
					path: fsPath(flutterHelloWorldMainFile),
				}),
			);

			const evaluateResult = await dc.evaluateForFrame(`(new DateTime.now()).year`);
			assert.ok(evaluateResult);
			assert.equal(evaluateResult.result, (new Date()).getFullYear());
			assert.equal(evaluateResult.variablesReference, 0);

			await waitAllThrowIfTerminates(dc,
				dc.waitForEvent("terminated"),
				dc.terminateRequest(),
			);
		});
	});

	describe("can evaluate when not at a breakpoint (global expression evaluation)", function () {
		this.beforeEach(function () {
			if (flutterTestDeviceIsWeb)
				this.skip();
		});

		it("simple expressions", async () => {
			await openFile(flutterHelloWorldMainFile);
			const config = await startDebugger(dc, flutterHelloWorldMainFile);
			await waitAllThrowIfTerminates(dc,
				dc.configurationSequence(),
				dc.launch(config),
			);

			const evaluateResult = await dc.evaluateRequest({ expression: `"test"` });
			assert.ok(evaluateResult);
			assert.ok(evaluateResult.body);
			assert.equal(evaluateResult.body.result, `"test"`);
			assert.equal(evaluateResult.body.variablesReference, 0);

			await waitAllThrowIfTerminates(dc,
				dc.waitForEvent("terminated"),
				dc.terminateRequest(),
			);
		});

		it("complex expression expressions", async () => {
			await openFile(flutterHelloWorldMainFile);
			const config = await startDebugger(dc, flutterHelloWorldMainFile);
			await waitAllThrowIfTerminates(dc,
				dc.configurationSequence(),
				dc.launch(config),
			);

			const evaluateResult = await dc.evaluateRequest({ expression: `(new DateTime.now()).year` });
			assert.ok(evaluateResult);
			assert.ok(evaluateResult.body);
			assert.equal(evaluateResult.body.result, (new Date()).getFullYear());
			assert.equal(evaluateResult.body.variablesReference, 0);

			await waitAllThrowIfTerminates(dc,
				dc.waitForEvent("terminated"),
				dc.terminateRequest(),
			);
		});

		it("an expression that returns a variable", async () => {
			await openFile(flutterHelloWorldMainFile);
			const config = await startDebugger(dc, flutterHelloWorldMainFile);
			await waitAllThrowIfTerminates(dc,
				dc.configurationSequence(),
				dc.launch(config),
			);

			const evaluateResult = await dc.evaluateRequest({ expression: `new DateTime.now()` });
			const thisYear = new Date().getFullYear().toString();
			assert.ok(evaluateResult);
			assert.ok(evaluateResult.body);
			assert.ok(evaluateResult.body.result.startsWith("DateTime (" + thisYear), `Result '${evaluateResult.body.result}' did not start with ${thisYear}`);
			assert.ok(evaluateResult.body.variablesReference);

			await waitAllThrowIfTerminates(dc,
				dc.waitForEvent("terminated"),
				dc.terminateRequest(),
			);
		});
	});

	// Skipped due to https://github.com/flutter/flutter/issues/17007.
	it.skip("stops on exception", async () => {
		await openFile(flutterHelloWorldBrokenFile);
		const config = await startDebugger(dc, flutterHelloWorldBrokenFile);
		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence(),
			dc.assertStoppedLocation("exception", {
				line: positionOf("^Oops").line + 1, // positionOf is 0-based, but seems to want 1-based
				path: fsPath(flutterHelloWorldBrokenFile),
			}),
			dc.launch(config),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("does not stop on exception in noDebug mode", async () => {
		await openFile(flutterHelloWorldBrokenFile);
		const config = await startDebugger(dc, flutterHelloWorldBrokenFile);
		config.noDebug = true;

		let didStop = false;

		dc.waitForEvent("stopped")
			.then(() => didStop = true)
			.catch(() => {
				// Swallow errors, as we don't care if this times out, we're only using it
				// to tell if we stopped by the time we hit the end of this test.
			});

		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence()
				.then(() => delay(20000))
				.then(() => dc.terminateRequest()),
			dc.waitForEvent("terminated"),
			dc.launch(config),
		);

		assert.equal(didStop, false);
	});

	// Skipped due to https://github.com/flutter/flutter/issues/17007.
	it.skip("provides exception details when stopped on exception", async () => {
		await openFile(flutterHelloWorldBrokenFile);
		const config = await startDebugger(dc, flutterHelloWorldBrokenFile);
		await waitAllThrowIfTerminates(dc,
			dc.configurationSequence(),
			dc.assertStoppedLocation("exception", {
				line: positionOf("^won't find this").line + 1, // positionOf is 0-based, but seems to want 1-based
				path: fsPath(flutterHelloWorldBrokenFile),
			}),
			dc.launch(config),
		);

		const variables = await dc.getTopFrameVariables("Exception");
		ensureVariable(variables, "$e.message", "message", `"(TODO WHEN UNSKIPPING)"`);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("writes exception to stderr", async () => {
		await openFile(flutterHelloWorldBrokenFile);
		const config = await startDebugger(dc, flutterHelloWorldBrokenFile);
		await waitAllThrowIfTerminates(dc,
			watchPromise("writes_failure_output->configurationSequence", dc.configurationSequence()),
			watchPromise("writes_failure_output->assertOutputContains", dc.assertOutputContains("stderr", "Exception: Oops\n")),
			watchPromise("writes_failure_output->launch", dc.launch(config)),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("moves known files from call stacks to metadata", async function () {
		// https://github.com/dart-lang/webdev/issues/949
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldBrokenFile);
		const config = await startDebugger(dc, flutterHelloWorldBrokenFile);
		await waitAllThrowIfTerminates(dc,
			watchPromise("writes_failure_output->configurationSequence", dc.configurationSequence()),
			watchPromise(
				"writes_failure_output->assertOutputContains",
				dc.assertOutputContains("stderr", "_throwAnException")
					.then((event) => {
						assert.equal(event.body.output.indexOf("package:flutter_hello_world/broken.dart"), -1);
						assert.equal(event.body.source!.name, "package:flutter_hello_world/broken.dart");
						assert.equal(event.body.source!.path, fsPath(flutterHelloWorldBrokenFile));
						assert.equal(event.body.line, positionOf("^Oops").line + 1); // positionOf is 0-based, but seems to want 1-based
						assert.equal(event.body.column, 5);
					}),
			),
			watchPromise("writes_failure_output->launch", dc.launch(config)),
		);

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);
	});

	it("renders correct output for structured errors", async function () {
		if (!extApi.flutterCapabilities.hasLatestStructuredErrorsWork)
			return this.skip();

		// Currently this test fails on Chrome because we always lose the race
		// with enabling structured errors versus the error occurring
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldBrokenFile);
		const config = await startDebugger(dc, flutterHelloWorldBrokenFile);

		// Collect all output to stderr.
		let stderrOutput = "";
		const handleOutput = (event: DebugProtocol.OutputEvent) => {
			if (event.body.category === "stderr") {
				stderrOutput += event.body.output;
			}
		};
		dc.on("output", handleOutput);
		try {

			await waitAllThrowIfTerminates(dc,
				dc.configurationSequence(),
				dc.launch(config),
			);

			await waitForResult(
				() => stderrOutput.toLowerCase().indexOf("═══ exception caught by widgets library ═══") !== -1
					&& stderrOutput.indexOf("════════════════════════════════════════════════════════════════════════════════") !== -1,
				"Waiting for error output",
				5000,
			);
		} finally {
			dc.removeListener("output", handleOutput);
		}

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);

		// Grab online the lines that form our error.
		let stdErrLines = stderrOutput.split("\n").map((l) => l.trim());
		// Trim off stuff before our error.
		const firstErrorLine = stdErrLines.findIndex((l) => l.toLowerCase().indexOf("exception caught by widgets library") !== -1);
		stdErrLines = stdErrLines.slice(firstErrorLine);
		// Trim off stuff after our error.
		const lastErrorLine = stdErrLines.findIndex((l) => l.indexOf("════════════════════════════════════════════════════════════════════════════════") !== -1);
		stdErrLines = stdErrLines.slice(0, lastErrorLine + 1);

		// Because we run in verbose mode, there may be timings on the front, so trim them off.
		const timingRegex = new RegExp("\[[ \d]+\] ", "g");
		stdErrLines = stdErrLines.map((line) => line.replace(timingRegex, ""));

		// Handle old/new error messages for stable/dev.
		const expectedErrorLines = [
			grey2(`════════ Exception caught by widgets library ═══════════════════════════════════`),
			grey(`The following _Exception was thrown building MyBrokenHomePage(dirty):`),
			`Exception: Oops`,
			grey(`The relevant error-causing widget was`),
			grey2(`MyBrokenHomePage`),
			grey(`When the exception was thrown, this was the stack`),
			grey2(`#0      MyBrokenHomePage._throwAnException`),
			grey2(`#1      MyBrokenHomePage.build`),
			grey(`#2      StatelessElement.build`),
			grey(`#3      ComponentElement.performRebuild`),
			grey(`#4      Element.rebuild`),
			grey(`...`),
			grey2(`════════════════════════════════════════════════════════════════════════════════`),
		];

		assert.deepStrictEqual(stdErrLines.map((s) => s.toLowerCase()), expectedErrorLines.map((s) => s.toLowerCase()));
	});

	it("does not print original error if using structured errors", async function () {
		if (!extApi.flutterCapabilities.hasLatestStructuredErrorsWork)
			return this.skip();

		// Currently this test fails on Chrome because we always lose the race
		// with enabling structured errors versus the error occurring
		if (flutterTestDeviceIsWeb)
			return this.skip();

		await openFile(flutterHelloWorldBrokenFile);
		const config = await startDebugger(dc, flutterHelloWorldBrokenFile);

		// Collect all output to stderr.
		let stderrOutput = "";
		const handleOutput = (event: DebugProtocol.OutputEvent) => {
			if (event.body.category === "stderr") {
				stderrOutput += event.body.output;
			}
		};
		dc.on("output", handleOutput);
		try {

			await waitAllThrowIfTerminates(dc,
				dc.configurationSequence(),
				dc.launch(config),
			);

			await waitForResult(
				() => stderrOutput.toLowerCase().indexOf("═══ exception caught by widgets library ═══") !== -1
					&& stderrOutput.indexOf("════════════════════════════════════════════════════════════════════════════════") !== -1,
				"Waiting for error output",
				5000,
			);

			await delay(500); // Additional delay in case the stderr error arrives after the one detected above.
		} finally {
			dc.removeListener("output", handleOutput);
		}

		await waitAllThrowIfTerminates(dc,
			dc.waitForEvent("terminated"),
			dc.terminateRequest(),
		);

		assert.equal(stderrOutput.toLowerCase().indexOf("══╡ exception caught"), -1);
	});
});
