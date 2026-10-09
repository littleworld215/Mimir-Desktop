using System;

internal static class Program {
  static int Main() {
    try {
      var endpoint = Environment.GetEnvironmentVariable("MIMIR_PIPE_ENDPOINT");
      int port;
      Guid id;
      const string prefix = @"\\.\pipe\mimir-assets-";
      if (endpoint == null || !endpoint.StartsWith(prefix, StringComparison.Ordinal) ||
          !Guid.TryParseExact(endpoint.Substring(prefix.Length), "D", out id) ||
          !Int32.TryParse(Environment.GetEnvironmentVariable("MIMIR_PIPE_PORT"), out port) || port < 1 || port > 65535) return 1;
      AssetsNativePipe.Run(endpoint, port);
      return Environment.ExitCode;
    } catch { return 1; }
  }
}
