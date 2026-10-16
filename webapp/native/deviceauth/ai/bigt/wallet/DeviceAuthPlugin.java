package ai.bigt.wallet;

import android.app.Activity;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Device-unlock confirmation for important transactions.
 *
 * The app ships as a Capacitor WebView, so a payment/order is signed in JS with
 * the wallet key loaded in memory — a compromised or unattended unlocked phone
 * could move funds with no further prompt. This plugin gates the signing step on
 * the OS unlock: `BiometricPrompt` accepts a fingerprint/face OR the device
 * credential (PIN/pattern/password), so it works on every phone, not only ones
 * with enrolled biometrics. `setAllowedAuthenticators` with DEVICE_CREDENTIAL
 * falls back to the keyguard on pre-API-30 devices through the compat library.
 *
 * Registered from MainActivity alongside UpdaterPlugin; the Java sources live in
 * the tracked template webapp/native/deviceauth and are copied in on every
 * `cap sync` (android/ is generated + gitignored).
 */
@CapacitorPlugin(name = "DeviceAuth")
public class DeviceAuthPlugin extends Plugin {

  /** Whether the OS can currently authenticate (biometric or device credential). */
  @PluginMethod
  public void isAvailable(PluginCall call) {
    BiometricManager bm = BiometricManager.from(getContext());
    int can = bm.canAuthenticate(
        BiometricManager.Authenticators.BIOMETRIC_WEAK
            | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
    JSObject ret = new JSObject();
    ret.put("available", can == BiometricManager.BIOMETRIC_SUCCESS);
    ret.put("code", can);
    call.resolve(ret);
  }

  /** Show the unlock prompt; resolves {ok:true} on success, {ok:false} otherwise. */
  @PluginMethod
  public void confirm(PluginCall call) {
    Activity activity = getActivity();
    if (!(activity instanceof FragmentActivity)) {
      JSObject ret = new JSObject();
      ret.put("ok", false);
      ret.put("error", "activity is not a FragmentActivity");
      call.resolve(ret);
      return;
    }
    final String title = call.getString("title", "Confirm");
    final String subtitle = call.getString("subtitle", "");
    final String description = call.getString("reason", "");

    activity.runOnUiThread(() -> {
      BiometricPrompt prompt = new BiometricPrompt(
          (FragmentActivity) activity,
          ContextCompat.getMainExecutor(getContext()),
          new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(
                @NonNull BiometricPrompt.AuthenticationResult result) {
              JSObject ret = new JSObject();
              ret.put("ok", true);
              call.resolve(ret);
            }

            @Override
            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
              // user cancelled, no credential set, lockout, … — all non-fatal
              JSObject ret = new JSObject();
              ret.put("ok", false);
              ret.put("code", errorCode);
              ret.put("error", errString.toString());
              call.resolve(ret);
            }

            @Override
            public void onAuthenticationFailed() {
              // a wrong finger; the prompt stays up for another try
            }
          });

      BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setAllowedAuthenticators(
              BiometricManager.Authenticators.BIOMETRIC_WEAK
                  | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
      if (!subtitle.isEmpty()) info.setSubtitle(subtitle);
      if (!description.isEmpty()) info.setDescription(description);

      try {
        prompt.authenticate(info.build());
      } catch (Exception e) {
        JSObject ret = new JSObject();
        ret.put("ok", false);
        ret.put("error", String.valueOf(e.getMessage()));
        call.resolve(ret);
      }
    });
  }
}
