package com.example.bapp.webapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

/**
 * Receives the PackageInstaller session status broadcast and resolves the
 * pending install() PluginCall. A separate receiver is required because the
 * installer's PendingIntent targets a receiver component, not an activity.
 */
public class UpdateReceiver extends BroadcastReceiver {

  @Override
  public void onReceive(Context context, Intent intent) {
    int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
    int sessionId = intent.getIntExtra("sessionId", -1);
    String callId = intent.getStringExtra("callId");

    JSObject out = new JSObject();
    out.put("status", status);
    out.put("sessionId", sessionId);
    out.put("success", status == PackageInstaller.STATUS_SUCCESS);

    PluginCall call = UpdaterPlugin.PENDING.remove(callId);
    if (call != null) {
      if (status == PackageInstaller.STATUS_SUCCESS) call.resolve(out);
      else call.reject("install status " + status);
    }
  }
}
