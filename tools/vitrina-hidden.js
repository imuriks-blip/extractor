// vitrina-hidden.js - hidden launcher for the Extractor vitrina (EXT-38, spec SPEC-extractor-vitrina section 5, Ivan's decision V-9).
// ASCII only (no bytes above 0x7F). JScript, run by the Startup shortcut (tools\install-autostart.ps1) or tools\update.ps1 as:
//   wscript.exe //B //Nologo //E:JScript <root>\tools\vitrina-hidden.js <node.exe> [--wait]
// Starts "node server.mjs" in <root> (the folder above this file) with a hidden window (window style 0: the console
// is created hidden, no flash - not "powershell -WindowStyle Hidden", see rake T4). node.exe comes as an absolute path
// from the installer, so PATH at Windows logon does not matter.
// node gets --console-log: it appends its own output and an uncaught error to <root>\data\vitrina\console.log
// line by line (no cmd ">>" redirect: that file stayed locked by the first instance and a second start failed
// with code 1 before node ran - V9 probe). The launcher empties console.log first when it is over 1 MB.
// The vitrina writes its own events to data\vitrina\server.log; a second start exits 0 with an "already" line there.
// Default: do not wait (the launcher exits at once). --wait: wait for node and return its exit code (probes).
// If node cannot be started, one ASCII line goes to console.log and the exit code is 9009.
var args = WScript.Arguments;
var fso = new ActiveXObject('Scripting.FileSystemObject');
var sh = new ActiveXObject('WScript.Shell');

var node = args.length ? args(0) : '';
var wait = false;
for (var i = 1; i < args.length; i++) if (args(i) === '--wait') wait = true;

var root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName));
var data = fso.BuildPath(root, 'data');
var dir = fso.BuildPath(data, 'vitrina');
var out = fso.BuildPath(dir, 'console.log');

function note(text) {
  try {
    var f = fso.OpenTextFile(out, 8, true, 0);
    f.WriteLine(text);
    f.Close();
  } catch (e) { /* nothing more to do */ }
}

var rc = 0;
try {
  if (!fso.FolderExists(data)) fso.CreateFolder(data);
  if (!fso.FolderExists(dir)) fso.CreateFolder(dir);
  if (fso.FileExists(out) && fso.GetFile(out).Size > 1048576) fso.CreateTextFile(out, true, false).Close();
} catch (e0) { /* server.mjs creates data\vitrina itself */ }

try {
  if (!node || !fso.FileExists(node)) throw { message: 'no such file: ' + node };
  var line = '"' + node + '" "' + fso.BuildPath(root, 'server.mjs') + '" --console-log';
  sh.CurrentDirectory = root;
  rc = sh.Run(line, 0, wait);
  if (!wait) rc = 0;
} catch (e) {
  note(new Date().toUTCString() + ' vitrina-hidden: node did not start: ' + (e.message || e.description || e));
  rc = 9009;
}
WScript.Quit(rc);
