import * as React from "react";
import { useCallback, useState } from "react";
import {
  Alert,
  TextInput,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
} from "react-native";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { useWallet } from "@/state/wallet";
import {
  createWallet,
  importPrivateKey,
  importOldWalletFile,
  isPlainWalletJson,
  loadWallet,
  parseOldWalletFile,
  saveKeyToFile,
  base64ToBytes,
  type WalletFile,
} from "./WalletHelper";

type CreateWalletStep =
  | "idle"
  | "created"
  | "enterPassword"
  | "saving"
  | "done";
type ImportKeyStep = "idle" | "enterKey" | "enterPassword" | "saving" | "done";
type LoadFileStep = "idle" | "enterPassword" | "loading" | "done";
type OldWalletStep =
  | "idle"
  | "enterOldPassword"
  | "enterNewPassword"
  | "saving"
  | "done";

const isWeb = Platform.OS === "web";

export default function KeysScreen() {
  const { t } = useTranslation();
  const {
    publicInfo,
    isUnlocked,
    storeEncryptedWallet,
    lockWallet,
    unlockWallet,
  } = useWallet();

  const hasExistingWallet = !!publicInfo?.hasEncryptedWallet;

  // State for wallet creation flow
  const [step, setStep] = useState<CreateWalletStep>("idle");
  const [newWallet, setNewWallet] = useState<WalletFile | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  // State for loading existing wallet
  const [loadMode, setLoadMode] = useState(false);
  const [loadPassword, setLoadPassword] = useState("");
  const [loadedWallet, setLoadedWallet] = useState<WalletFile | null>(null);

  // State for unlocking existing wallet
  const [unlockPassword, setUnlockPassword] = useState("");
  const [isUnlocking, setIsUnlocking] = useState(false);

  // State for import private key flow
  const [importStep, setImportStep] = useState<ImportKeyStep>("idle");
  const [privateKeyInput, setPrivateKeyInput] = useState("");
  const [importedWallet, setImportedWallet] = useState<WalletFile | null>(null);

  // State for load from file flow
  const [loadFileStep, setLoadFileStep] = useState<LoadFileStep>("idle");
  const [loadFilePassword, setLoadFilePassword] = useState("");
  const [loadedFileContent, setLoadedFileContent] = useState<string>("");

  // State for importing an old-format .wallet file (legacy protobuf)
  const [oldWalletStep, setOldWalletStep] = useState<OldWalletStep>("idle");
  const [oldWalletBytes, setOldWalletBytes] = useState<Uint8Array | null>(null);
  const [oldWalletPassword, setOldWalletPassword] = useState("");

  // Create a new wallet
  const handleCreateWallet = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage("");

    try {
      const wallet = await createWallet();
      setNewWallet(wallet);
      setWalletAddress(wallet.wallet.address);
      setStep("created");
    } catch (error) {
      console.error("Error creating wallet:", error);
      const msg = (error as Error).message;
      setErrorMessage(t("keys.errCreate", { message: msg }));
      Alert.alert(t("keys.errorHead"), t("keys.errCreate", { message: msg }));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // Proceed to password entry
  const handleProceedToPassword = useCallback(() => {
    setStep("enterPassword");
  }, []);

  // Save wallet with password
  const handleSaveWallet = useCallback(async () => {
    if (!newWallet) {
      setErrorMessage(t("keys.errNoWallet"));
      return;
    }

    if (!password) {
      setErrorMessage(t("keys.errEnterPassword"));
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage(t("keys.errMismatch"));
      return;
    }

    if (password.length < 6) {
      setErrorMessage(t("keys.errShortPassword"));
      return;
    }

    setIsLoading(true);
    setErrorMessage("");
    setStep("saving");

    try {
      const encryptedContent = await saveKeyToFile(newWallet, password);

      await storeEncryptedWallet(
        encryptedContent,
        newWallet.wallet.address,
        password,
      );

      const fileName = `wallet_${newWallet.wallet.address.slice(0, 8)}_${Date.now()}.json`;

      if (isWeb) {
        const blob = new Blob([encryptedContent], { type: "application/json" });

        if (typeof (globalThis as any).showSaveFilePicker === "function") {
          try {
            const handle = await (globalThis as any).showSaveFilePicker({
              suggestedName: fileName,
              types: [
                {
                  description: "JSON Wallet File",
                  accept: { "application/json": [".json"] },
                },
              ],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();

            setStep("done");
            Alert.alert(t("keys.successHead"), t("keys.walletSavedMsg"));
          } catch (pickerError: any) {
            if (pickerError.name === "AbortError") {
              setStep("enterPassword");
              setErrorMessage(t("keys.errSaveCancelled"));
              setIsLoading(false);
              return;
            }
            throw pickerError;
          }
        } else {
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = fileName;
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);

          setStep("done");
          Alert.alert(t("keys.successHead"), t("keys.createdDownloaded"));
        }
      } else {
        const documentsDir = (FileSystem as any).documentDirectory;
        if (!documentsDir) {
          throw new Error("Documents directory not available");
        }

        const filePath = `${documentsDir}${fileName}`;
        await (FileSystem as any).writeAsStringAsync(
          filePath,
          encryptedContent,
        );

        const sharingAvailable = await Sharing.isAvailableAsync();

        if (sharingAvailable) {
          Alert.alert(
            t("keys.created"),
            t("keys.walletCreatedFile"),
            [
              {
                text: t("keys.saveWalletFile"),
                onPress: () => {
                  Sharing.shareAsync(filePath, {
                    mimeType: "application/json",
                    dialogTitle: t("keys.shareSheetTitle"),
                    UTI: "public.json",
                  })
                    .then(() => setStep("done"))
                    .catch(() => setStep("done"));
                },
              },
            ],
          );
        } else {
          setStep("done");
          Alert.alert(t("keys.saved"), t("keys.savedAs", { fileName }));
        }
      }
    } catch (error) {
      console.error("Error saving wallet:", error);
      const msg = (error as Error).message;
      setErrorMessage(t("keys.errSave", { message: msg }));
      setStep("enterPassword");
      Alert.alert(t("keys.errorHead"), t("keys.errSave", { message: msg }));
    } finally {
      setIsLoading(false);
    }
  }, [newWallet, password, confirmPassword, storeEncryptedWallet, t]);

  // Reset to start over
  const handleReset = useCallback(() => {
    setStep("idle");
    setNewWallet(null);
    setPassword("");
    setConfirmPassword("");
    setWalletAddress("");
    setErrorMessage("");
    setLoadMode(false);
    setLoadPassword("");
    setLoadedWallet(null);
    setImportStep("idle");
    setPrivateKeyInput("");
    setImportedWallet(null);
    setLoadFileStep("idle");
    setLoadFilePassword("");
    setLoadedFileContent("");
    setOldWalletStep("idle");
    setOldWalletBytes(null);
    setOldWalletPassword("");
    setUnlockPassword("");
    setIsUnlocking(false);
  }, []);

  // Unlock existing wallet
  const handleUnlockWallet = useCallback(async () => {
    if (!unlockPassword) {
      setErrorMessage(t("keys.errEnterYourPassword"));
      return;
    }

    setIsUnlocking(true);
    setErrorMessage("");

    try {
      await unlockWallet(unlockPassword);
      setUnlockPassword("");
      Alert.alert(t("keys.successHead"), t("keys.unlockSuccess"));
    } catch (error) {
      console.error("Error unlocking wallet:", error);
      setErrorMessage(t("keys.wrongPassword"));
      Alert.alert(t("keys.errorHead"), t("keys.wrongPassword"));
    } finally {
      setIsUnlocking(false);
    }
  }, [unlockPassword, unlockWallet, t]);

  // Start load from file flow
  const handleLoadFromFile = useCallback(async () => {
    setErrorMessage("");

    try {
      if (isWeb) {
        // Web file picker
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";

        input.onchange = async (e: any) => {
          const file = e.target?.files?.[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
              const content = event.target?.result as string;
              setLoadedFileContent(content);
              // Unencrypted wallet files (plain SerializedWallet) need no
              // password — go straight to loading.
              setLoadFileStep(isPlainWalletJson(content) ? "loading" : "enterPassword");
            };
            reader.onerror = () => {
              setErrorMessage(t("keys.failReadFile"));
              Alert.alert(t("keys.errorHead"), t("keys.failReadFile"));
            };
            reader.readAsText(file);
          }
        };

        input.click();
      } else {
        // Native file picker
        const result = await DocumentPicker.getDocumentAsync({
          type: "application/json",
          copyToCacheDirectory: true,
        });

        if (result.canceled) {
          return;
        }

        const fileUri = result.assets[0].uri;
        const content = await FileSystem.readAsStringAsync(fileUri);
        setLoadedFileContent(content);
        setLoadFileStep(isPlainWalletJson(content) ? "loading" : "enterPassword");
      }
    } catch (error) {
      console.error("Error loading file:", error);
      const msg = (error as Error).message;
      setErrorMessage(t("keys.failLoadFile", { message: msg }));
      Alert.alert(t("keys.errorHead"), t("keys.failLoadFile", { message: msg }));
    }
  }, [t]);

  // Load wallet from file with password
  const handleLoadWalletFromFile = useCallback(async () => {
    if (!loadedFileContent) {
      setErrorMessage(t("keys.errNoFileLoaded"));
      return;
    }

    // Unencrypted wallet files need no password; encrypted ones do.
    const needsPassword = !isPlainWalletJson(loadedFileContent);
    if (needsPassword && !loadFilePassword) {
      setErrorMessage(t("keys.errEnterPassword"));
      return;
    }

    setIsLoading(true);
    setErrorMessage("");
    setLoadFileStep("loading");

    try {
      const wallet = await loadWallet(loadedFileContent, loadFilePassword);
      await storeEncryptedWallet(
        loadedFileContent,
        wallet.wallet.address,
        loadFilePassword,
      );

      setLoadFileStep("done");
      Alert.alert(t("keys.successHead"), t("keys.loadSuccess"));
    } catch (error) {
      console.error("Error loading wallet:", error);
      const msg = (error as Error).message;
      setErrorMessage(t("keys.failLoadWallet", { message: msg }));
      setLoadFileStep("enterPassword");
      Alert.alert(t("keys.errorHead"), t("keys.failLoadWallet", { message: msg }));
    } finally {
      setIsLoading(false);
    }
  }, [loadedFileContent, loadFilePassword, storeEncryptedWallet, t]);

  // Start import private key flow
  const handleStartImport = useCallback(() => {
    setImportStep("enterKey");
    setErrorMessage("");
  }, []);

  // Import private key
  const handleImportKey = useCallback(async () => {
    if (!privateKeyInput.trim()) {
      setErrorMessage(t("keys.errPrivateKey"));
      return;
    }

    setIsLoading(true);
    setErrorMessage("");

    try {
      const wallet = await importPrivateKey(privateKeyInput);
      setImportedWallet(wallet);
      setWalletAddress(wallet.wallet.address);
      setImportStep("enterPassword");
    } catch (error) {
      console.error("Error importing private key:", error);
      const msg = (error as Error).message;
      setErrorMessage(t("keys.failImportKey", { message: msg }));
      Alert.alert(t("keys.errorHead"), t("keys.failImportKey", { message: msg }));
    } finally {
      setIsLoading(false);
    }
  }, [privateKeyInput, t]);

  // Save imported wallet
  const handleSaveImportedWallet = useCallback(async () => {
    if (!importedWallet) return;

    if (!password || password !== confirmPassword) {
      setErrorMessage(t("keys.errMismatch"));
      return;
    }

    if (password.length < 6) {
      setErrorMessage(t("keys.errShortPassword"));
      return;
    }

    setIsLoading(true);
    setImportStep("saving");

    try {
      const encryptedContent = await saveKeyToFile(importedWallet, password);
      await storeEncryptedWallet(
        encryptedContent,
        importedWallet.wallet.address,
        password,
      );

      setImportStep("done");
      Alert.alert(t("keys.successHead"), t("keys.importSaved"));
    } catch (error) {
      const msg = (error as Error).message;
      setErrorMessage(t("keys.errSave", { message: msg }));
      setImportStep("enterPassword");
      Alert.alert(t("keys.errorHead"), t("keys.errSave", { message: msg }));
    } finally {
      setIsLoading(false);
    }
  }, [importedWallet, password, confirmPassword, storeEncryptedWallet, t]);

  // Start import of an old-format .wallet (legacy protobuf) file
  const handleStartOldWalletImport = useCallback(async () => {
    setErrorMessage("");

    const readBytes = async (fileUriOrBuffer: any): Promise<Uint8Array> => {
      if (isWeb) return new Uint8Array(fileUriOrBuffer);
      const b64 = await (FileSystem as any).readAsStringAsync(fileUriOrBuffer, {
        encoding: (FileSystem as any).EncodingType.Base64,
      });
      return base64ToBytes(b64);
    };

    const processBytes = async (bytes: Uint8Array) => {
      try {
        const meta = await parseOldWalletFile(bytes);
        setOldWalletBytes(bytes);
        if (meta.encrypted) {
          setOldWalletPassword("");
          setOldWalletStep("enterOldPassword");
        } else {
          const walletFile = await importOldWalletFile(bytes);
          setImportedWallet(walletFile);
          setWalletAddress(walletFile.wallet.address);
          setPassword("");
          setConfirmPassword("");
          setOldWalletStep("enterNewPassword");
        }
      } catch (error) {
        console.error("Error parsing old wallet:", error);
        const msg = (error as Error).message;
        setErrorMessage(t("keys.notValidWallet", { message: msg }));
        Alert.alert(t("keys.errorHead"), t("keys.notValidWallet", { message: msg }));
      }
    };

    try {
      if (isWeb) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".wallet,application/octet-stream";
        input.onchange = (e: any) => {
          const file = e.target?.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = (event) => {
            processBytes(new Uint8Array(event.target?.result as ArrayBuffer));
          };
          reader.onerror = () => {
            setErrorMessage(t("keys.failReadFile"));
            Alert.alert(t("keys.errorHead"), t("keys.failReadFile"));
          };
          reader.readAsArrayBuffer(file);
        };
        input.click();
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
        });
        if (result.canceled) return;
        const fileUri = result.assets[0].uri;
        processBytes(await readBytes(fileUri));
      }
    } catch (error) {
      console.error("Error loading old wallet file:", error);
      const msg = (error as Error).message;
      setErrorMessage(t("keys.failLoadFile", { message: msg }));
      Alert.alert(t("keys.errorHead"), t("keys.failLoadFile", { message: msg }));
    }
  }, [t]);

  // Decrypt an encrypted old .wallet file with its original password
  const handleDecryptOldWallet = useCallback(async () => {
    if (!oldWalletBytes) {
      setErrorMessage(t("keys.errNoFileLoaded"));
      return;
    }
    if (!oldWalletPassword) {
      setErrorMessage(t("keys.errOldPassword"));
      return;
    }

    setIsLoading(true);
    setErrorMessage("");
    try {
      const walletFile = await importOldWalletFile(
        oldWalletBytes,
        oldWalletPassword,
      );
      setImportedWallet(walletFile);
      setWalletAddress(walletFile.wallet.address);
      setPassword("");
      setConfirmPassword("");
      setOldWalletStep("enterNewPassword");
    } catch (error) {
      console.error("Error decrypting old wallet:", error);
      const msg = (error as Error).message;
      setErrorMessage(t("keys.failDecrypt", { message: msg }));
      Alert.alert(t("keys.errorHead"), t("keys.failDecrypt", { message: msg }));
    } finally {
      setIsLoading(false);
    }
  }, [oldWalletBytes, oldWalletPassword, t]);

  // Save the imported old wallet with a new password
  const handleSaveOldWallet = useCallback(async () => {
    if (!importedWallet) return;

    if (!password || password !== confirmPassword) {
      setErrorMessage(t("keys.errMismatch"));
      return;
    }

    if (password.length < 6) {
      setErrorMessage(t("keys.errShortPassword"));
      return;
    }

    setIsLoading(true);
    setErrorMessage("");
    setOldWalletStep("saving");

    try {
      const encryptedContent = await saveKeyToFile(importedWallet, password);
      await storeEncryptedWallet(
        encryptedContent,
        importedWallet.wallet.address,
        password,
      );

      setOldWalletStep("done");
      Alert.alert(t("keys.successHead"), t("keys.oldImported"));
    } catch (error) {
      console.error("Error saving old wallet:", error);
      const msg = (error as Error).message;
      setErrorMessage(t("keys.errSave", { message: msg }));
      setOldWalletStep("enterNewPassword");
      Alert.alert(t("keys.errorHead"), t("keys.errSave", { message: msg }));
    } finally {
      setIsLoading(false);
    }
  }, [importedWallet, password, confirmPassword, storeEncryptedWallet, t]);

  // Render functions
  const renderIdleState = () => (
    <View style={styles.container}>
      {hasExistingWallet && (
        <View style={styles.walletInfo}>
          <Text style={styles.label}>{t("keys.currentWallet")}</Text>
          <Text style={styles.address} selectable>
            {publicInfo?.address}
          </Text>
          <View style={styles.statusRow}>
            <View
              style={[styles.statusDot, isUnlocked && styles.statusDotUnlocked]}
            />
            <Text style={styles.statusText}>
              {isUnlocked ? t("keys.unlocked") : t("keys.locked")}
            </Text>
          </View>

          {!isUnlocked && (
            <>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>{t("keys.password")}</Text>
                <TextInput
                  style={styles.input}
                  value={unlockPassword}
                  onChangeText={setUnlockPassword}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={t("wallet.passwordPlaceholder")}
                />
              </View>

              {errorMessage ? (
                <Text style={styles.error}>{errorMessage}</Text>
              ) : null}

              <TouchableOpacity
                style={[styles.button, styles.buttonPrimary]}
                onPress={handleUnlockWallet}
                disabled={isUnlocking}
              >
                <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
                  {isUnlocking ? t("keys.unlocking") : t("keys.unlock")}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {isUnlocked && (
            <TouchableOpacity style={[styles.button, styles.buttonPrimary]} onPress={lockWallet}>
              <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.lock")}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <Text style={styles.description}>
        {t("keys.subtitle")}
      </Text>

      <TouchableOpacity
        style={[styles.button, styles.buttonPrimary]}
        onPress={handleCreateWallet}
        disabled={isLoading}
      >
        <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
          {t("keys.create")}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.buttonPrimary]}
        onPress={handleStartImport}
        disabled={isLoading}
      >
        <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.importKey")}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.buttonPrimary]}
        onPress={handleLoadFromFile}
        disabled={isLoading}
      >
        <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.loadFile")}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.buttonPrimary]}
        onPress={handleStartOldWalletImport}
        disabled={isLoading}
      >
        <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
          {t("keys.loadOldWallet")}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderCreatedState = () => (
    <View style={styles.container}>
      <Text style={styles.title}>{t("keys.created")}</Text>

      <View style={styles.walletInfo}>
        <Text style={styles.label}>{t("keys.yourAddress")}</Text>
        <Text style={styles.address} selectable>
          {walletAddress}
        </Text>
        <Text style={styles.label}>{t("keys.yourPublicKey")}</Text>
        <Text style={styles.address} selectable>
          {newWallet?.wallet.pubkey ?? ""}
        </Text>
      </View>

      <Text style={styles.warning}>
        {t("keys.important")}
      </Text>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, styles.buttonFlex]}
          onPress={handleProceedToPassword}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
            {t("keys.saveWithPassword")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, styles.buttonFlex]}
          onPress={handleReset}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.cancel")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderPasswordState = () => (
    <View style={styles.container}>
      <Text style={styles.title}>{t("keys.setPassword")}</Text>

      <Text style={styles.description}>
        {t("keys.passwordNote")}
      </Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("keys.password")}</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("keys.enterPassword")}
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("keys.confirmPassword")}</Text>
        <TextInput
          style={styles.input}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("keys.confirmPassword2")}
        />
      </View>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, styles.buttonFlex]}
          onPress={handleSaveWallet}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
            {isLoading ? t("keys.saving") : t("keys.saveWallet")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, styles.buttonFlex]}
          onPress={() => setStep("created")}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.back")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderDoneState = () => (
    <View style={styles.container}>
      <Text style={[styles.title, styles.successText]}>
        {t("keys.saved")}
      </Text>

      <View style={styles.walletInfo}>
        <Text style={styles.label}>{t("keys.yourAddress")}</Text>
        <Text style={styles.address} selectable>
          {walletAddress}
        </Text>
      </View>

      <Text style={styles.description}>
        {t("keys.savedSub")}
      </Text>

      <TouchableOpacity
        style={[styles.button, styles.buttonPrimary]}
        onPress={handleReset}
      >
        <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.done")}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderImportEnterKeyState = () => (
    <View style={styles.container}>
      <Text style={styles.title}>{t("keys.importKey")}</Text>

      <Text style={styles.description}>
        {t("keys.importKeyDesc")}
      </Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("keys.privateKey")}</Text>
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          value={privateKeyInput}
          onChangeText={setPrivateKeyInput}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          multiline
          numberOfLines={3}
          placeholder={t("keys.privateKeyPh")}
        />
      </View>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, styles.buttonFlex]}
          onPress={handleImportKey}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
            {isLoading ? t("keys.importing") : t("keys.importKeyBtn")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonFlex]}
          onPress={handleReset}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.cancel")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderImportPasswordState = () => (
    <View style={styles.container}>
      <Text style={styles.title}>{t("keys.setPassword")}</Text>

      <View style={styles.walletInfo}>
        <Text style={styles.label}>{t("keys.yourAddress")}</Text>
        <Text style={styles.address} selectable>
          {walletAddress}
        </Text>
      </View>

      <Text style={styles.description}>
        {t("keys.passwordNote")}
      </Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("keys.password")}</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("keys.enterPassword")}
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("keys.confirmPassword")}</Text>
        <TextInput
          style={styles.input}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("keys.confirmPassword2")}
        />
      </View>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, styles.buttonFlex]}
          onPress={handleSaveImportedWallet}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
            {isLoading ? t("keys.saving") : t("keys.saveWallet")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonFlex]}
          onPress={handleReset}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.cancel")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderLoadFilePasswordState = () => {
    const isPlain = isPlainWalletJson(loadedFileContent ?? "");
    return (
    <View style={styles.container}>
      <Text style={styles.title}>{t("keys.loadTitle")}</Text>

      <Text style={styles.description}>
        {isPlain ? t("keys.fileNotEncrypted") : t("keys.fileEncryptedDesc")}
      </Text>

      {!isPlain && (
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>{t("keys.password")}</Text>
          <TextInput
            style={styles.input}
            value={loadFilePassword}
            onChangeText={setLoadFilePassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("wallet.passwordPlaceholder")}
          />
        </View>
      )}

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, styles.buttonFlex]}
          onPress={handleLoadWalletFromFile}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
            {isLoading ? t("keys.loading") : t("keys.loadWalletBtn")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonFlex]}
          onPress={handleReset}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.cancel")}</Text>
        </TouchableOpacity>
      </View>
    </View>
    );
  };

  const renderOldWalletOldPasswordState = () => (
    <View style={styles.container}>
      <Text style={styles.title}>{t("keys.oldTitle")}</Text>

      <Text style={styles.description}>
        {t("keys.oldDesc")}
      </Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("keys.oldWalletPassword")}</Text>
        <TextInput
          style={styles.input}
          value={oldWalletPassword}
          onChangeText={setOldWalletPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("keys.oldPwPh")}
        />
      </View>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, styles.buttonFlex]}
          onPress={handleDecryptOldWallet}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
            {isLoading ? t("keys.decrypting") : t("keys.continue")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonFlex]}
          onPress={handleReset}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.cancel")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderOldWalletNewPasswordState = () => (
    <View style={styles.container}>
      <Text style={styles.title}>{t("keys.setPassword")}</Text>

      <View style={styles.walletInfo}>
        <Text style={styles.label}>{t("keys.yourAddress")}</Text>
        <Text style={styles.address} selectable>
          {walletAddress}
        </Text>
      </View>

      <Text style={styles.description}>
        {t("keys.passwordNote")}
      </Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("keys.password")}</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("keys.enterPassword")}
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("keys.confirmPassword")}</Text>
        <TextInput
          style={styles.input}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("keys.confirmPassword2")}
        />
      </View>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, styles.buttonFlex]}
          onPress={handleSaveOldWallet}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
            {isLoading ? t("keys.saving") : t("keys.saveWallet")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonFlex]}
          onPress={handleReset}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{t("keys.cancel")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <ScrollView style={styles.scrollView}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t("keys.manageKeys")}</Text>
      </View>

      {isLoading &&
      step === "idle" &&
      importStep === "idle" &&
      loadFileStep === "idle" ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" />
        </View>
      ) : oldWalletStep === "enterOldPassword" ? (
        renderOldWalletOldPasswordState()
      ) : oldWalletStep === "enterNewPassword" ||
        oldWalletStep === "saving" ? (
        renderOldWalletNewPasswordState()
      ) : oldWalletStep === "done" ? (
        renderDoneState()
      ) : loadFileStep === "enterPassword" || loadFileStep === "loading" ? (
        renderLoadFilePasswordState()
      ) : loadFileStep === "done" ? (
        renderDoneState()
      ) : importStep === "enterKey" ? (
        renderImportEnterKeyState()
      ) : importStep === "enterPassword" || importStep === "saving" ? (
        renderImportPasswordState()
      ) : importStep === "done" ? (
        renderDoneState()
      ) : step === "idle" ? (
        renderIdleState()
      ) : step === "created" ? (
        renderCreatedState()
      ) : step === "enterPassword" || step === "saving" ? (
        renderPasswordState()
      ) : step === "done" ? (
        renderDoneState()
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scrollView: {
    flex: 1,
    backgroundColor: theme.colors.groupped.background,
  },
  header: {
    padding: theme.margins.lg,
    backgroundColor: theme.colors.header.background,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: theme.colors.text.primary,
  },
  container: {
    padding: theme.margins.lg,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: theme.colors.text.primary,
    marginBottom: theme.margins.md,
  },
  successText: {
    color: theme.colors.accent?.emerald ?? theme.colors.primary,
  },
  description: {
    fontSize: 14,
    color: theme.colors.text.secondary,
    marginBottom: theme.margins.lg,
    lineHeight: 20,
  },
  warning: {
    fontSize: 14,
    color: theme.colors.text.secondary,
    marginBottom: theme.margins.lg,
    lineHeight: 20,
    backgroundColor: theme.colors.surfacePressed,
    padding: theme.margins.md,
    borderRadius: theme.borderRadius.md,
  },
  walletInfo: {
    backgroundColor: theme.colors.groupped.surface,
    padding: theme.margins.md,
    borderRadius: theme.borderRadius.xl,
    marginBottom: theme.margins.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.text.secondary,
    marginBottom: theme.margins.xs,
  },
  address: {
    fontSize: 14,
    color: theme.colors.text.primary,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      web: "monospace",
    }),
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: theme.margins.sm,
    gap: theme.margins.xs,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.text.secondary,
  },
  statusDotUnlocked: {
    backgroundColor: theme.colors.accent?.emerald ?? theme.colors.primary,
  },
  statusText: {
    fontSize: 14,
    color: theme.colors.text.secondary,
  },
  inputGroup: {
    marginBottom: theme.margins.md,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.text.primary,
    marginBottom: theme.margins.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.groupped.surface,
    color: theme.colors.text.primary,
    borderRadius: theme.borderRadius.md,
    padding: theme.margins.md,
    fontSize: 14,
  },
  inputMultiline: {
    minHeight: 80,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      web: "monospace",
    }),
  },
  error: {
    fontSize: 14,
    color: theme.colors.accent?.red ?? theme.colors.text.secondary,
    marginBottom: theme.margins.md,
  },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
    paddingVertical: 15,
    paddingHorizontal: theme.margins.md,
    alignItems: "center",
    marginTop: theme.margins.sm,
  },
  buttonText: {
    fontSize: 16,
    color: "#FFFFFF",
    fontWeight: "600",
  },
  buttonPrimary: {},
  buttonTextPrimary: {},
  buttonRow: {
    flexDirection: "row",
    gap: theme.margins.sm,
  },
  buttonFlex: {
    flex: 1,
  },
  loadingContainer: {
    padding: theme.margins.xl,
    alignItems: "center",
  },
}));
