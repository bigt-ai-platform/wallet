package ai.bigt.wallet;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Wallet-file save bridge for the Capacitor WebView.
 *
 * The Android System WebView has no `showSaveFilePicker`, and an
 * `<a download>` click is a silent no-op because the shell installs no
 * `DownloadListener` — so "Back up wallet file" produced no file on the phone.
 * This plugin is the native save path:
 *
 *  - API 29+: insert into the public Downloads collection
 *    (`Download/Wallet/<name>.json`), the way a browser download would land,
 *    and return its content:// uri.
 *  - API < 29: write to the app's external documents dir
 *    (`Android/data/<pkg>/files/Documents/`, exposed by the existing
 *    FileProvider) since scoped-storage-free public writes need a permission
 *    this app does not request.
 *
 * `share` then opens the system share sheet for that uri, so the file can also
 * leave the phone (Files, Drive, mail). The web layer treats a dismissed share
 * as success: the copy is already saved.
 *
 * Copied into the generated android/ project by `scripts/patch-android.mjs` on
 * every `cap sync` (android/ is gitignored).
 */
@CapacitorPlugin(name = "WalletFile")
public class WalletFilePlugin extends Plugin {

  private static final String DEFAULT_MIME = "application/json";
  private static final String DEFAULT_NAME = "wallet.json";

  /** Save `content` as `fileName` and resolve with { uri, fileName, location }. */
  @PluginMethod
  public void save(PluginCall call) {
    final String content = call.getString("content");
    if (content == null) {
      call.reject("content is required");
      return;
    }
    final String fileName = sanitize(call.getString("fileName", DEFAULT_NAME));
    final String mimeType = call.getString("mimeType", DEFAULT_MIME);
    final byte[] bytes = content.getBytes(StandardCharsets.UTF_8);

    getBridge()
        .execute(
            () -> {
              try {
                JSObject ret = new JSObject();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                  Uri uri = saveToDownloads(fileName, bytes, mimeType);
                  ret.put("uri", uri.toString());
                  ret.put("location", "Downloads/Wallet/" + fileName);
                } else {
                  File file = saveToAppDocuments(fileName, bytes);
                  Uri uri =
                      FileProvider.getUriForFile(
                          getContext(),
                          getContext().getPackageName() + ".fileprovider",
                          file);
                  ret.put("uri", uri.toString());
                  ret.put("location", file.getAbsolutePath());
                }
                ret.put("fileName", fileName);
                call.resolve(ret);
              } catch (Exception e) {
                call.reject("could not save wallet file: " + e.getMessage(), e);
              }
            });
  }

  /** Open the system share sheet for a uri returned by {@link #save}. */
  @PluginMethod
  public void share(PluginCall call) {
    final String uriString = call.getString("uri");
    if (uriString == null || uriString.isEmpty()) {
      call.reject("uri is required");
      return;
    }
    final String fileName = call.getString("fileName", DEFAULT_NAME);
    final String mimeType = call.getString("mimeType", DEFAULT_MIME);
    try {
      Uri uri = Uri.parse(uriString);
      Intent send = new Intent(Intent.ACTION_SEND);
      send.setType(mimeType);
      send.putExtra(Intent.EXTRA_STREAM, uri);
      send.putExtra(Intent.EXTRA_SUBJECT, fileName);
      // ClipData carries the read grant to the chosen target reliably.
      send.setClipData(ClipData.newUri(getContext().getContentResolver(), fileName, uri));
      send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      Intent chooser = Intent.createChooser(send, fileName);
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      getContext().startActivity(chooser);
      JSObject ret = new JSObject();
      ret.put("shared", true);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("share failed: " + e.getMessage(), e);
    }
  }

  private Uri saveToDownloads(String fileName, byte[] bytes, String mimeType)
      throws IOException {
    ContentResolver cr = getContext().getContentResolver();
    ContentValues values = new ContentValues();
    values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
    values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
    values.put(
        MediaStore.MediaColumns.RELATIVE_PATH,
        Environment.DIRECTORY_DOWNLOADS + File.separator + "Wallet");
    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
    Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
    if (uri == null) throw new IOException("Downloads provider refused the insert");
    try {
      try (OutputStream out = cr.openOutputStream(uri)) {
        if (out == null) throw new IOException("cannot open " + uri);
        out.write(bytes);
        out.flush();
      }
      ContentValues done = new ContentValues();
      done.put(MediaStore.MediaColumns.IS_PENDING, 0);
      cr.update(uri, done, null, null);
      return uri;
    } catch (IOException | RuntimeException e) {
      cr.delete(uri, null, null);
      throw e;
    }
  }

  private File saveToAppDocuments(String fileName, byte[] bytes) throws IOException {
    File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
    if (dir == null) dir = getContext().getCacheDir();
    if (dir == null) throw new IOException("no writable directory");
    //noinspection ResultOfMethodCallIgnored
    dir.mkdirs();
    File out = new File(dir, fileName);
    try (FileOutputStream fos = new FileOutputStream(out)) {
      fos.write(bytes);
      fos.flush();
    }
    return out;
  }

  /** Keep the name a plain file name: no traversal, no separators. */
  private static String sanitize(String name) {
    String cleaned = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "_");
    cleaned = cleaned.replaceFirst("^\\.+", "");
    if (cleaned.isEmpty()) cleaned = DEFAULT_NAME;
    if (!cleaned.toLowerCase().endsWith(".json")) cleaned = cleaned + ".json";
    return cleaned;
  }
}
