import * as React from "react";
import {
  View, Text, TextInput, TouchableOpacity, Modal, Platform,
  ActivityIndicator, ScrollView,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as DocumentPicker from "expo-document-picker";
import { CloseIcon, QrScanIcon } from "@/components/Icons";
import { MONO_FONT } from "@/constants/fonts";
import { decodeQrFromImageSource } from "@/lib/qrImage";

/**
 * Full-screen QR scanner sheet used by the Send Payment screen.
 *
 * Content is handed to the caller as raw text via `onScanned`; classification
 * (payment request vs url link) happens in the caller so it can act on the
 * wallet's state (tokens, destination chain selection).
 *
 * Decode paths:
 *  - native: live camera feed (expo-camera) + picking a QR image from the
 *    device (expo-camera scanFromURLAsync).
 *  - web: no live camera feed — pick an image and decode in-browser (jsQR),
 *    or paste the QR payload by hand.
 * A manual "paste content" input is always shown as a simulator/fallback path.
 */
export interface QrScannerModalProps {
  visible: boolean;
  onClose: () => void;
  onScanned: (content: string) => void;
}

export default function QrScannerModal({ visible, onClose, onScanned }: QrScannerModalProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const handledRef = React.useRef(false);

  // Reset per-open state so a previously scanned value doesn't fire again.
  React.useEffect(() => {
    if (visible) {
      handledRef.current = false;
      setManual("");
      setError("");
    }
  }, [visible]);

  const isNative = Platform.OS !== "web";
  const showCamera = visible && isNative && permission?.granted;

  const fireScan = React.useCallback(
    (content: string) => {
      if (handledRef.current) return;
      const value = (content ?? "").trim();
      if (!value) return;
      handledRef.current = true;
      onScanned(value);
    },
    [onScanned],
  );

  const handleBarcodeScanned = React.useCallback(
    ({ data }: BarcodeScanningResult) => fireScan(data),
    [fireScan],
  );

  const pickQrImage = React.useCallback(async () => {
    setError("");
    try {
      if (Platform.OS === "web") {
        // Native <input type="file"> — matches the wallet-file import path.
        await new Promise<void>((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.onchange = async (e: any) => {
            const file: File | undefined = e.target?.files?.[0];
            if (file) {
              setBusy(true);
              try {
                const content = await decodeQrFromImageSource({ uri: "", file });
                if (content) fireScan(content);
                else setError(t("qr.noQrFound"));
              } catch (err) {
                console.error("QR image decode failed:", err);
                setError(t("qr.decodeFailed"));
              } finally {
                setBusy(false);
              }
            }
            resolve();
          };
          input.click();
        });
        return;
      }

      // Native: pick an image and scan it with the platform barcode scanner.
      const result = await DocumentPicker.getDocumentAsync({
        type: "image/*",
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      setBusy(true);
      try {
        const content = await decodeQrFromImageSource({ uri: result.assets[0].uri });
        if (content) fireScan(content);
        else setError(t("qr.noQrFound"));
      } catch (err) {
        console.error("QR image decode failed:", err);
        setError(t("qr.decodeFailed"));
      } finally {
        setBusy(false);
      }
    } catch (err) {
      console.error("QR image pick failed:", err);
      setError(t("qr.decodeFailed"));
    }
  }, [fireScan, t]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.overlay} testID="qr-scanner">
        <View style={s.sheet}>
          <View style={s.header}>
            <View style={s.headerTitleWrap}>
              <QrScanIcon size={18} color={theme.colors.primary} />
              <Text style={s.headerTitle}>{t('qr.title')}</Text>
            </View>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.cancel')} testID="qr-close">
              <CloseIcon size={20} color={theme.colors.text.secondary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
            {isNative ? (
              showCamera ? (
                <View style={s.cameraWrap}>
                  <CameraView
                    style={s.camera}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={handleBarcodeScanned}
                  />
                  <View style={s.cameraOverlay} pointerEvents="none">
                    <View style={s.scanFrame} />
                  </View>
                  <Text style={s.cameraHint}>{t('qr.cameraHint')}</Text>
                </View>
              ) : (
                <View style={s.permissionCard}>
                  <Text style={s.permissionTitle}>
                    {permission?.granted ? t('qr.cameraUnavailable') : permission?.canAskAgain ? t('qr.cameraDeniedAsk') : t('qr.cameraDenied')}
                  </Text>
                  {permission && !permission.granted && permission.canAskAgain && (
                    <TouchableOpacity style={s.primaryBtn} onPress={() => requestPermission()}>
                      <Text style={s.primaryBtnText}>{t('qr.allowCamera')}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )
            ) : (
              <View style={s.permissionCard}>
                <Text style={s.permissionTitle}>{t('qr.webNoCamera')}</Text>
              </View>
            )}

            <TouchableOpacity style={s.imageBtn} onPress={pickQrImage} disabled={busy} testID="qr-pick-image">
              {busy ? (
                <ActivityIndicator size="small" color={s.imageBtnText.color} />
              ) : (
                <Text style={s.imageBtnText}>{t('qr.pickImage')}</Text>
              )}
            </TouchableOpacity>

            <View style={s.manualCard}>
              <Text style={s.manualLabel}>{t('qr.manualLabel')}</Text>
              <TextInput
                style={s.input}
                value={manual}
                onChangeText={setManual}
                placeholder={t('qr.manualPlaceholder')}
                placeholderTextColor={s.placeholder.color}
                autoCapitalize="none"
                autoCorrect={false}
                testID="qr-manual-input"
              />
              <TouchableOpacity
                style={[s.secondaryBtn, !manual.trim() && s.btnDisabled]}
                onPress={() => fireScan(manual)}
                disabled={!manual.trim()}
                testID="qr-manual-apply"
              >
                <Text style={s.secondaryBtnText}>{t('qr.apply')}</Text>
              </TouchableOpacity>
            </View>

            {error ? <Text style={s.errorText}>{error}</Text> : null}
            <Text style={s.hint}>{t('qr.acceptedHint')}</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create((theme) => ({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.groupped.background,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '88%',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  headerTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 17, fontWeight: '700', color: theme.colors.text.primary },
  body: { paddingBottom: 12 },
  cameraWrap: { borderRadius: 12, overflow: 'hidden', marginBottom: 12, backgroundColor: '#000' },
  camera: { width: '100%', height: 280 },
  cameraOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 220, height: 220, borderWidth: 2, borderColor: theme.colors.primary, borderRadius: 12, opacity: 0.9 },
  cameraHint: { fontSize: 12, color: '#FFFFFF', backgroundColor: 'rgba(0,0,0,0.55)', textAlign: 'center', paddingVertical: 6 },
  permissionCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 16, alignItems: 'center', marginBottom: 12 },
  permissionTitle: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', lineHeight: 20, marginBottom: 12 },
  primaryBtn: { backgroundColor: theme.colors.primary, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 24, alignItems: 'center' },
  primaryBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  imageBtn: { backgroundColor: theme.colors.primarySoft, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: theme.colors.border },
  imageBtnText: { color: theme.colors.primary, fontSize: 15, fontWeight: '600' },
  manualCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 12, marginBottom: 12 },
  manualLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 14, fontFamily: MONO_FONT, marginBottom: 10 },
  placeholder: { color: theme.colors.text.secondary },
  secondaryBtn: { borderRadius: 8, borderWidth: 1, borderColor: theme.colors.primary, paddingVertical: 10, alignItems: 'center' },
  secondaryBtnText: { fontSize: 14, fontWeight: '600', color: theme.colors.primary },
  btnDisabled: { opacity: 0.4 },
  errorText: { color: theme.colors.accent.red, fontSize: 13, marginBottom: 8, textAlign: 'center' },
  hint: { fontSize: 12, color: theme.colors.text.secondary, textAlign: 'center', lineHeight: 17 },
}));
