package ai.bigt.wallet;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Native system-notification bridge, mirroring ../dai
 * (apps/webapp/native/notifier/ai/bigt/dai/NotifierPlugin.java).
 *
 * The Android System WebView has no `Notification` constructor, so the web
 * layer posts OS notifications through this plugin: it owns the notification
 * channel (API 26+) and the POST_NOTIFICATIONS runtime permission (API 33+).
 * Only delivers while the app process is alive — the wallet polls chain
 * status from the WebView, so true background push is a separate effort.
 *
 * Copied into the generated android/ project by `scripts/patch-android.mjs` on
 * every `cap sync` (android/ is gitignored).
 */
@CapacitorPlugin(
    name = "Notifier",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class NotifierPlugin extends Plugin {

  private static final String CHANNEL_ID = "wallet_events";

  /** Create the channel up-front: Android 8+ drops a notification whose
   *  channel does not exist yet. */
  @Override
  public void load() {
    ensureChannel();
  }

  private boolean allowed() {
    if (Build.VERSION.SDK_INT >= 33
        && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
      return false;
    }
    return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
  }

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager nm =
          (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
      if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
        NotificationChannel channel =
            new NotificationChannel(CHANNEL_ID, "Wallet", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Payments, orders and chain events");
        nm.createNotificationChannel(channel);
      }
    }
  }

  @PluginMethod
  public void checkNotifyPermission(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("granted", allowed());
    call.resolve(ret);
  }

  @PluginMethod
  public void requestNotifyPermission(PluginCall call) {
    // Before API 33 notifications are on by default; just create the channel.
    if (Build.VERSION.SDK_INT < 33 || allowed()) {
      ensureChannel();
      JSObject ret = new JSObject();
      ret.put("granted", allowed());
      call.resolve(ret);
      return;
    }
    requestPermissionForAlias("notifications", call, "notifyPermissionCallback");
  }

  @PermissionCallback
  private void notifyPermissionCallback(PluginCall call) {
    ensureChannel();
    JSObject ret = new JSObject();
    ret.put("granted", allowed());
    call.resolve(ret);
  }

  @PluginMethod
  public void notify(PluginCall call) {
    String title = call.getString("title", "Wallet");
    String body = call.getString("body", "");
    String tag = call.getString("tag", "wallet");

    JSObject ret = new JSObject();
    ensureChannel();
    if (!allowed()) {
      ret.put("posted", false);
      call.resolve(ret);
      return;
    }

    Intent launch =
        getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
    PendingIntent contentIntent = null;
    if (launch != null) {
      launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
      contentIntent =
          PendingIntent.getActivity(
              getContext(), 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    Notification notification =
        new NotificationCompat.Builder(getContext(), CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_wallet)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .build();

    NotificationManagerCompat.from(getContext()).notify(tag, 0, notification);
    ret.put("posted", true);
    call.resolve(ret);
  }
}
