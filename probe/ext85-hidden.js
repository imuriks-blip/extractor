// ext85-hidden.js - EXT-85 probe: the same hidden start as tools\vitrina-hidden.js, for a probe instance.
// ASCII only. JScript:
//   wscript.exe //B //Nologo //E:JScript probe\ext85-hidden.js <node.exe> <workdir> <node arg>...
// Runs "<node.exe>" <node arg>... in <workdir> through WScript.Shell.Run with window style 0 (the console is created
// hidden, no flash - rake T4) and does not wait, exactly as vitrina-hidden.js does for the live vitrina. The only
// difference: node arguments come from the command line (the probe adds --import of probe\ext85-sleep.mjs and its
// own server.mjs path) instead of the fixed "<root>\server.mjs --console-log".
// If node cannot be started, exit code 9009 (nothing else is written: the probe start script checks the pulse files).
var args = WScript.Arguments;
var fso = new ActiveXObject('Scripting.FileSystemObject');
var sh = new ActiveXObject('WScript.Shell');
var rc = 0;
try {
  if (args.length < 3) throw { message: 'usage: ext85-hidden.js <node.exe> <workdir> <node arg>...' };
  var node = args(0);
  if (!fso.FileExists(node)) throw { message: 'no such file: ' + node };
  var line = '"' + node + '"';
  for (var i = 2; i < args.length; i++) line += ' "' + args(i) + '"';
  sh.CurrentDirectory = args(1);
  sh.Run(line, 0, false);
} catch (e) {
  rc = 9009;
}
WScript.Quit(rc);
