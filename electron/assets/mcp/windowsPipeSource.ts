/** 固定受信源码随bundle分发；仅转发字节，不读取资产、发现文件或模型配置。 */
export const WINDOWS_PIPE_SOURCE = String.raw`
using System;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class AssetsNativePipe {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafePipeHandle CreateNamedPipeW(string name, uint open, uint mode, uint instances, uint output, uint input, uint timeout, ref SA security);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static readonly object gate = new object();
  static readonly HashSet<IDisposable> resources = new HashSet<IDisposable>();
  static readonly HashSet<Task> tasks = new HashSet<Task>();
  static void Observe(Task task) { }
  static void Track(IDisposable value) { lock(gate) resources.Add(value); }
  static void Release(IDisposable value) { lock(gate) resources.Remove(value); value.Dispose(); }
  static void Emit(string value) { lock(gate) { Console.Out.WriteLine(value); Console.Out.Flush(); } }
  static NamedPipeServerStream Instance(string endpoint, int ordinal, string sid) {
    IntPtr descriptor = IntPtr.Zero; uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor("O:"+sid+"D:P(D;;GA;;;NU)(A;;GA;;;"+sid+")", 1, out descriptor, out size)) throw new IOException();
    try {
      var sa = new SA { length = Marshal.SizeOf(typeof(SA)), descriptor = descriptor, inherit = 0 };
      // Reject remote clients on EVERY successful Create; first-instance guard only for ordinal 1.
      var handle = CreateNamedPipeW(endpoint, 3u | 0x40000000u | (ordinal == 1 ? 0x80000u : 0u), 0x8u, 16, 65536, 65536, 0, ref sa);
      if (handle.IsInvalid) { handle.Dispose(); throw new IOException(); }
      NamedPipeServerStream pipe = null;
      try {
        pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        var security = pipe.GetAccessControl();
        if (security.GetOwner(typeof(SecurityIdentifier)).Value != sid || !security.AreAccessRulesProtected) throw new IOException();
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
        bool allowed = false, denied = false;
        if (rules.Count != 2) throw new IOException();
        foreach (PipeAccessRule rule in rules) {
          var who = rule.IdentityReference.Value;
          if (rule.IsInherited) throw new IOException();
          if (who == sid && rule.AccessControlType == AccessControlType.Allow && (int)rule.PipeAccessRights == 0x1f01ff) allowed = true;
          else if (who == "S-1-5-2" && rule.AccessControlType == AccessControlType.Deny && (int)rule.PipeAccessRights == 0x1f01ff) denied = true;
          else throw new IOException();
        }
        if (!allowed || !denied) throw new IOException();
        var dacl = security.GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
        Emit("{\"kind\":\"instance\",\"ordinal\":"+ordinal+",\"rejectRemote\":true,\"ownerSid\":\""+sid+"\",\"dacl\":\""+dacl+"\"}");
        return pipe;
      } catch { if (pipe != null) pipe.Dispose(); else handle.Dispose(); throw; }
    } finally { LocalFree(descriptor); }
  }
  static async Task Relay(NamedPipeServerStream pipe, int port, CancellationToken stop) {
    var tcp = new TcpClient(); Track(tcp);
    try {
      var connect = tcp.ConnectAsync("127.0.0.1", port);
      if (await Task.WhenAny(connect, Task.Delay(5000, stop)) != connect) throw new IOException();
      await connect;
      using (var linked = CancellationTokenSource.CreateLinkedTokenSource(stop)) {
        var stream = tcp.GetStream();
        var up = pipe.CopyToAsync(stream, 65536, linked.Token);
        var down = stream.CopyToAsync(pipe, 65536, linked.Token);
        await Task.WhenAny(up, down);
        linked.Cancel(); pipe.Dispose(); tcp.Close();
        try { await Task.WhenAll(up, down); } catch { }
      }
    } catch { } finally { Release(tcp); Release(pipe); }
  }
  static async Task RunAsync(string endpoint, int port) {
    using (var stop = new CancellationTokenSource())
    using (var slots = new SemaphoreSlim(15, 15)) {
      // Dedicated control reader: EOF is delivered even when no client ever connects.
      Observe(Task.Factory.StartNew(() => { try { using(var input = new StreamReader(Console.OpenStandardInput())) { input.ReadLine(); } } catch { } stop.Cancel(); }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default));
      int ordinal = 0;
      try {
        var sid = WindowsIdentity.GetCurrent().User.Value;
        while (!stop.IsCancellationRequested) {
          var pipe = Instance(endpoint, ++ordinal, sid); Track(pipe);
          if (ordinal == 1) Emit("{\"kind\":\"ready\"}");
          await slots.WaitAsync(stop.Token);
          try { await pipe.WaitForConnectionAsync(stop.Token); }
          catch { slots.Release(); throw; }
          var task = Relay(pipe, port, stop.Token);
          lock(gate) tasks.Add(task);
          Observe(task.ContinueWith(done => { lock(gate) tasks.Remove(done); slots.Release(); }, TaskScheduler.Default));
        }
      } finally {
        stop.Cancel();
        IDisposable[] owned; Task[] pending;
        lock(gate) { owned = new List<IDisposable>(resources).ToArray(); pending = new List<Task>(tasks).ToArray(); }
        foreach(var item in owned) { try { item.Dispose(); } catch { } }
        Task.WhenAll(pending).Wait(3000);
      }
    }
  }
  public static void Run(string endpoint, int port) {
    try { RunAsync(endpoint, port).GetAwaiter().GetResult(); }
    catch (OperationCanceledException) { }
    catch { Emit("{\"kind\":\"failed\"}"); Environment.ExitCode = 1; }
  }
}
`
