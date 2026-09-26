package com.example.bapp.webapp;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ConcurrentHashMap;

/**
 * OTA updater. The web layer resolves the release manifest (region-aware),
 * compares its versionCode against the installed build, and calls
 * {@link #install} to download + verify + install the signed APK via
 * {@link PackageInstaller} (no browser, no manual file step). The release
 * bucket is public-read; only the APK sha256 is trusted from the manifest and
 * is verified after download.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

  /** Pending install calls by callId, resolved by UpdateReceiver. */
  static final ConcurrentHashMap<String, PluginCall> PENDING = new ConcurrentHashMap<>();

  /** Current installed version (read from PackageManager — no BuildConfig). */
  @PluginMethod
  public void getVersion(PluginCall call) {
    JSObject o = new JSObject();
    try {
      o.put("versionCode", currentVersionCode());
      o.put("versionName", currentVersionName());
      call.resolve(o);
    } catch (Exception e) {
      call.reject("version read failed", e);
    }
  }

  private int currentVersionCode() {
    try {
      android.content.pm.PackageInfo pi =
          getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return (int) pi.getLongVersionCode();
      //noinspection deprecation
      return pi.versionCode;
    } catch (Exception e) {
      return 0;
    }
  }

  private String currentVersionName() {
    try {
      android.content.pm.PackageInfo pi =
          getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
      return pi.versionName != null ? pi.versionName : "";
    } catch (Exception e) {
      return "";
    }
  }

  /** Download the APK, verify its sha256, and install via PackageInstaller. */
  @PluginMethod
  public void install(PluginCall call) {
    String url = call.getString("url");
    String expectedSha = call.getString("sha256");
    if (url == null || url.isEmpty()) {
      call.reject("no apk url");
      return;
    }
    call.setKeepAlive(true);
    PENDING.put(call.getCallbackId(), call);
    getBridge().execute(() -> {
      try {
        File apk = downloadToCache(url);
        if (expectedSha != null && !expectedSha.isEmpty()) {
          String actual = sha256(apk);
          if (!expectedSha.equalsIgnoreCase(actual)) {
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
            PENDING.remove(call.getCallbackId());
            call.reject("sha256 mismatch: expected " + expectedSha + " got " + actual);
            return;
          }
        }
        getActivity().runOnUiThread(() -> performInstall(apk, call));
      } catch (Exception e) {
        PENDING.remove(call.getCallbackId());
        call.reject("download failed: " + e.getMessage());
      }
    });
  }

  private File downloadToCache(String urlString) throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL(urlString).openConnection();
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(60000);
    conn.setInstanceFollowRedirects(true);
    int code = conn.getResponseCode();
    if (code < 200 || code >= 300) {
      conn.disconnect();
      throw new IllegalStateException("HTTP " + code);
    }
    File dir = new File(getActivity().getCacheDir(), "ota");
    //noinspection ResultOfMethodCallIgnored
    dir.mkdirs();
    File apk = new File(dir, "update.apk");
    try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
      byte[] buf = new byte[8192];
      int n;
      while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    } finally {
      conn.disconnect();
    }
    return apk;
  }

  private static String sha256(File f) throws Exception {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    try (InputStream in = new FileInputStream(f)) {
      byte[] buf = new byte[8192];
      int n;
      while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
    }
    StringBuilder sb = new StringBuilder();
    for (byte b : md.digest()) sb.append(String.format("%02x", b));
    return sb.toString();
  }

  private void performInstall(File apk, PluginCall call) {
    Activity activity = getActivity();
    PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
    PackageInstaller.SessionParams params =
        new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
    try {
      int sessionId = installer.createSession(params);
      PackageInstaller.Session session = installer.openSession(sessionId);
      try (InputStream in = new FileInputStream(apk)) {
        try (OutputStream out = session.openWrite("update", 0, apk.length())) {
          byte[] buf = new byte[8192];
          int n;
          while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
      }
      session.commit(intentSender(activity, sessionId, call.getCallbackId()));
    } catch (Exception e) {
      PENDING.remove(call.getCallbackId());
      call.reject("install failed: " + e.getMessage());
    }
  }

  private android.content.IntentSender intentSender(Activity activity, int sessionId, String callId) {
    Intent intent = new Intent(activity, UpdateReceiver.class);
    intent.putExtra("sessionId", sessionId);
    intent.putExtra("callId", callId);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent pi = PendingIntent.getBroadcast(activity, sessionId, intent, flags);
    return pi.getIntentSender();
  }
}
