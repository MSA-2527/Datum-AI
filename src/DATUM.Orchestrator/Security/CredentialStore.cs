using System;
using System.IO;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Collections.Generic;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Security;

/// <summary>
/// Secret storage for provider API keys.
///
/// Keys were previously read from environment variables, which leak into child processes,
/// crash dumps and any support bundle the user sends us. They are now encrypted at rest
/// with DPAPI scoped to the current user, so the ciphertext is useless to another account
/// on the same machine and useless on any other machine.
///
/// The database never holds a secret. It stores a <c>keyRef</c> — a handle — and the
/// ciphertext lives in a separate file with its own ACL. That separation matters because
/// the SQLite file travels: it gets copied with project data, attached to bug reports, and
/// synced by backup tools.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class CredentialStore
{
    private const string Purpose = "DATUM.provider-credentials.v1";

    private readonly string _path;
    private readonly ILogger _log;

    public CredentialStore(string path, ILogger log)
    {
        _path = path;
        _log = log;
        string? dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
    }

    public static string DefaultPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "DATUM",
        "credentials.dat");

    /// <summary>Stores a secret and returns the handle to record in the database.</summary>
    public string Store(string keyRef, string secret)
    {
        if (string.IsNullOrWhiteSpace(keyRef)) throw new ArgumentException("keyRef is required", nameof(keyRef));

        var all = ReadAll();
        all[keyRef] = Protect(secret);
        WriteAll(all);

        _log.LogInformation("Stored credential for {KeyRef}.", keyRef);
        return keyRef;
    }

    /// <summary>
    /// Resolves a handle back to its secret, or null if absent or undecryptable.
    ///
    /// Undecryptable is normal, not exceptional: DPAPI ciphertext does not travel between
    /// users or machines, so a copied profile produces exactly this. Returning null lets
    /// the caller fall back to another provider instead of crashing the service.
    /// </summary>
    public string? Resolve(string? keyRef)
    {
        if (string.IsNullOrWhiteSpace(keyRef)) return null;

        var all = ReadAll();
        if (!all.TryGetValue(keyRef, out var cipher)) return null;

        try
        {
            return Unprotect(cipher);
        }
        catch (CryptographicException)
        {
            _log.LogWarning(
                "Credential {KeyRef} could not be decrypted. This normally means the store was " +
                "copied from another user or machine; re-enter the key.", keyRef);
            return null;
        }
    }

    public bool Delete(string keyRef)
    {
        var all = ReadAll();
        if (!all.Remove(keyRef)) return false;
        WriteAll(all);
        _log.LogInformation("Deleted credential {KeyRef}.", keyRef);
        return true;
    }

    public IReadOnlyCollection<string> List() => ReadAll().Keys;

    public bool Has(string keyRef) => ReadAll().ContainsKey(keyRef);

    /// <summary>
    /// One-time migration from environment variables.
    ///
    /// Existing installs configured with ANTHROPIC_API_KEY keep working, but the key gets
    /// encrypted on first run rather than being read from the environment forever.
    /// </summary>
    public int ImportFromEnvironment()
    {
        var map = new (string Env, string Ref)[]
        {
            ("ANTHROPIC_API_KEY", "byo-anthropic"),
            ("DATUM_PRO_KEY", "pro"),
            ("AZURE_OPENAI_KEY", "azure"),
            ("OPENAI_API_KEY", "byo-openai"),
        };

        int imported = 0;
        foreach (var (env, keyRef) in map)
        {
            string? value = Environment.GetEnvironmentVariable(env);
            if (string.IsNullOrWhiteSpace(value)) continue;
            if (Has(keyRef)) continue; // never overwrite a stored key with a stale env var

            Store(keyRef, value);
            imported++;
        }

        if (imported > 0)
            _log.LogInformation("Imported {N} credential(s) from environment variables.", imported);
        return imported;
    }

    // ── internals ────────────────────────────────────────────────────────────

    private static string Protect(string plaintext)
    {
        byte[] cipher = ProtectedData.Protect(
            Encoding.UTF8.GetBytes(plaintext),
            Encoding.UTF8.GetBytes(Purpose),
            DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(cipher);
    }

    private static string Unprotect(string base64)
    {
        byte[] plain = ProtectedData.Unprotect(
            Convert.FromBase64String(base64),
            Encoding.UTF8.GetBytes(Purpose),
            DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(plain);
    }

    private Dictionary<string, string> ReadAll()
    {
        if (!File.Exists(_path)) return new Dictionary<string, string>(StringComparer.Ordinal);

        try
        {
            string json = File.ReadAllText(_path);
            return JsonSerializer.Deserialize<Dictionary<string, string>>(json)
                   ?? new Dictionary<string, string>(StringComparer.Ordinal);
        }
        catch (Exception ex)
        {
            // A corrupt store must not take the service down. Starting empty means the
            // user re-enters a key; throwing here would mean they cannot start at all.
            _log.LogError(ex, "Credential store at {Path} is unreadable; starting empty.", _path);
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }
    }

    private void WriteAll(Dictionary<string, string> all)
    {
        // Write to a temp file and move, so a crash mid-write cannot leave a truncated
        // store that loses every key rather than just the one being added.
        string tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(all));
        File.Move(tmp, _path, overwrite: true);
    }
}
