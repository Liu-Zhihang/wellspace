$ErrorActionPreference = 'Stop'

$source = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;

public static class WsaSocksBridge
{
    private const int BufferSize = 65536;

    public static void Run(int port)
    {
        var listener = new TcpListener(IPAddress.Parse("127.0.0.1"), port);
        listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        listener.Start(128);
        Console.Error.WriteLine("listening 127.0.0.1:" + port + " -> wsl.exe -d Ubuntu -- nc 127.0.0.1 1080");

        while (true)
        {
            var client = listener.AcceptTcpClient();
            var worker = new Thread(() => Handle(client));
            worker.IsBackground = true;
            worker.Start();
        }
    }

    private static void Handle(TcpClient client)
    {
        Process proc = null;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "wsl.exe",
                Arguments = "-d Ubuntu -- nc 127.0.0.1 1080",
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            proc = Process.Start(psi);

            var stderrDrain = new Thread(() =>
            {
                try { proc.StandardError.ReadToEnd(); } catch {}
            });
            stderrDrain.IsBackground = true;
            stderrDrain.Start();

            var network = client.GetStream();
            var toWsl = new Thread(() => Copy(network, proc.StandardInput.BaseStream));
            var fromWsl = new Thread(() => Copy(proc.StandardOutput.BaseStream, network));
            toWsl.IsBackground = true;
            fromWsl.IsBackground = true;
            toWsl.Start();
            fromWsl.Start();

            while (toWsl.IsAlive && fromWsl.IsAlive)
            {
                Thread.Sleep(100);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("connection error: " + ex.Message);
        }
        finally
        {
            try { client.Close(); } catch {}
            if (proc != null)
            {
                try
                {
                    if (!proc.HasExited) proc.Kill();
                }
                catch {}
                try { proc.Dispose(); } catch {}
            }
        }
    }

    private static void Copy(Stream source, Stream destination)
    {
        var buffer = new byte[BufferSize];
        try
        {
            while (true)
            {
                int n = source.Read(buffer, 0, buffer.Length);
                if (n <= 0) break;
                destination.Write(buffer, 0, n);
                destination.Flush();
            }
        }
        catch {}
        finally
        {
            try { destination.Close(); } catch {}
            try { source.Close(); } catch {}
        }
    }
}
"@

Add-Type -TypeDefinition $source
[WsaSocksBridge]::Run(2081)
