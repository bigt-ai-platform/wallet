import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
  en: {
    translation: {
      nav: { transaction: 'Transaction', wallet: 'Wallet', market: 'Market', tokens: 'Tokens', settings: 'Settings' },
      wallet: { locked: 'Wallet Locked', lockedSub: 'Unlock your wallet to view assets and balance', manageWallet: 'Manage Wallet', manageKeys: 'Manage Keys', yourAddress: 'Your Address', assets: 'Assets', refresh: 'Refresh', noAssets: 'No assets found' },
      transaction: { title: 'Send Payment', locked: 'Wallet Locked', lockedSub: 'Unlock your wallet to send payments', unlock: 'Unlock Wallet', selectToken: 'Select Token', noTokens: 'No tokens available', recipient: 'Recipient', amount: 'Amount', memo: 'Memo (Optional)', send: 'Send Payment', sending: 'Sending...', available: 'Available', confirmTitle: 'Confirm Transaction', cancel: 'Cancel', send_: 'Send', success: 'Transaction sent!', error: 'Error', insufficient: 'Insufficient balance' },
      market: { title: 'Market', subtitle: 'Live token prices', noData: 'No market data available' },
      tokens: { title: 'Tokens', search: 'Search by name or ID', noTokens: 'No tokens available', noMatches: 'No matches', tryDifferent: 'Try a different search term' },
      settings: { title: 'Settings', testnet: 'Testnet', testnetDesc: 'Connect to test network', serverUrl: 'Server URL', save: 'Save', about: 'About', appVersion: 'App Version', network: 'Network', testnet_: 'Testnet', mainnet: 'Mainnet', reset: 'Reset to Defaults', saved: 'Saved', serverUpdated: 'Server URL updated', resetDone: 'Settings restored to defaults', urlEmpty: 'Server URL cannot be empty' },
      keys: { manageKeys: 'Manage Keys', create: 'Create New Wallet', saveWithPassword: 'Save with Password', enterPassword: 'Enter password (min 6 characters)', confirmPassword: 'Confirm password', saveWallet: 'Save Wallet', saving: 'Saving...', setPassword: 'Set Wallet Password', created: 'New Wallet Created!', saved: 'Wallet Saved Successfully!', importKey: 'Import Private Key', loadFile: 'Load from File', done: 'Done', back: 'Back', cancel: 'Cancel', unlock: 'Unlock Wallet', unlocking: 'Unlocking...', lock: 'Lock Wallet', currentWallet: 'Current Wallet:', unlocked: 'Unlocked', locked: 'Locked', password: 'Password', yourAddress: 'Your wallet address:', important: 'Important: You must save this wallet with a secure password.' },
      sidebar: { bigt: 'bigT', home: 'Home' },
      common: { language: 'Language', langAriaChange: 'Change language' },
    },
  },
  zh: {
    translation: {
      nav: { transaction: '交易', wallet: '钱包', market: '市场', tokens: '代币', settings: '设置' },
      wallet: { locked: '钱包已锁定', lockedSub: '解锁钱包以查看资产和余额', manageWallet: '管理钱包', manageKeys: '管理密钥', yourAddress: '您的地址', assets: '资产', refresh: '刷新', noAssets: '未找到资产' },
      transaction: { title: '发送付款', locked: '钱包已锁定', lockedSub: '解锁钱包以发送付款', unlock: '解锁钱包', selectToken: '选择代币', noTokens: '没有可用代币', recipient: '接收地址', amount: '金额', memo: '备注（可选）', send: '发送付款', sending: '发送中...', available: '可用余额', confirmTitle: '确认交易', cancel: '取消', send_: '发送', success: '交易已发送！', error: '错误', insufficient: '余额不足' },
      market: { title: '市场', subtitle: '实时代币价格', noData: '没有市场数据' },
      tokens: { title: '代币', search: '按名称或ID搜索', noTokens: '没有可用代币', noMatches: '没有匹配结果', tryDifferent: '请尝试其他搜索词' },
      settings: { title: '设置', testnet: '测试网络', testnetDesc: '连接到测试网络', serverUrl: '服务器地址', save: '保存', about: '关于', appVersion: '应用版本', network: '网络', testnet_: '测试网', mainnet: '主网', reset: '恢复默认设置', saved: '已保存', serverUpdated: '服务器地址已更新', resetDone: '设置已恢复默认', urlEmpty: '服务器地址不能为空' },
      keys: { manageKeys: '管理密钥', create: '创建新钱包', saveWithPassword: '密码保存', enterPassword: '输入密码（至少6个字符）', confirmPassword: '确认密码', saveWallet: '保存钱包', saving: '保存中...', setPassword: '设置钱包密码', created: '钱包创建成功！', saved: '钱包保存成功！', importKey: '导入私钥', loadFile: '从文件加载', done: '完成', back: '返回', cancel: '取消', unlock: '解锁钱包', unlocking: '解锁中...', lock: '锁定钱包', currentWallet: '当前钱包：', unlocked: '已解锁', locked: '已锁定', password: '密码', yourAddress: '您的钱包地址：', important: '重要提示：您必须使用安全密码保存此钱包。' },
      sidebar: { bigt: 'bigT', home: '首页' },
      common: { language: '语言', langAriaChange: '切换语言' },
    },
  },
  de: {
    translation: {
      nav: { transaction: 'Transaktion', wallet: 'Geldbörse', market: 'Markt', tokens: 'Token', settings: 'Einstellungen' },
      wallet: { locked: 'Geldbörse gesperrt', lockedSub: 'Entsperren Sie Ihre Geldbörse', manageWallet: 'Geldbörse verwalten', manageKeys: 'Schlüssel verwalten', yourAddress: 'Ihre Adresse', assets: 'Vermögenswerte', refresh: 'Aktualisieren', noAssets: 'Keine Vermögenswerte gefunden' },
      transaction: { title: 'Zahlung senden', locked: 'Geldbörse gesperrt', lockedSub: 'Geldbörse zum Senden entsperren', unlock: 'Entsperren', selectToken: 'Token wählen', noTokens: 'Keine Token verfügbar', recipient: 'Empfänger', amount: 'Betrag', memo: 'Notiz (optional)', send: 'Zahlung senden', sending: 'Sende...', available: 'Verfügbar', confirmTitle: 'Transaktion bestätigen', cancel: 'Abbrechen', send_: 'Senden', success: 'Transaktion gesendet!', error: 'Fehler', insufficient: 'Nicht genügend Guthaben' },
      market: { title: 'Markt', subtitle: 'Live-Token-Preise', noData: 'Keine Marktdaten verfügbar' },
      tokens: { title: 'Token', search: 'Nach Name oder ID suchen', noTokens: 'Keine Token verfügbar', noMatches: 'Keine Treffer', tryDifferent: 'Anderen Suchbegriff versuchen' },
      settings: { title: 'Einstellungen', testnet: 'Testnetz', testnetDesc: 'Mit Testnetz verbinden', serverUrl: 'Server-URL', save: 'Speichern', about: 'Über', appVersion: 'App-Version', network: 'Netzwerk', testnet_: 'Testnetz', mainnet: 'Hauptnetz', reset: 'Zurücksetzen', saved: 'Gespeichert', serverUpdated: 'Server-URL aktualisiert', resetDone: 'Einstellungen zurückgesetzt', urlEmpty: 'Server-URL darf nicht leer sein' },
      keys: { manageKeys: 'Schlüssel verwalten', create: 'Neue Geldbörse erstellen', saveWithPassword: 'Mit Passwort speichern', enterPassword: 'Passwort eingeben (min. 6 Zeichen)', confirmPassword: 'Passwort bestätigen', saveWallet: 'Geldbörse speichern', saving: 'Speichere...', setPassword: 'Passwort festlegen', created: 'Geldbörse erstellt!', saved: 'Geldbörse gespeichert!', importKey: 'Privaten Schlüssel importieren', loadFile: 'Aus Datei laden', done: 'Fertig', back: 'Zurück', cancel: 'Abbrechen', unlock: 'Entsperren', unlocking: 'Entsperre...', lock: 'Sperren', currentWallet: 'Aktuelle Geldbörse:', unlocked: 'Entsperrt', locked: 'Gesperrt', password: 'Passwort', yourAddress: 'Ihre Geldbörsen-Adresse:', important: 'Wichtig: Sie müssen diese Geldbörse mit einem sicheren Passwort speichern.' },
      sidebar: { bigt: 'bigT', home: 'Start' },
      common: { language: 'Sprache', langAriaChange: 'Sprache ändern' },
    },
  },
  fr: {
    translation: {
      nav: { transaction: 'Transaction', wallet: 'Portefeuille', market: 'Marché', tokens: 'Jetons', settings: 'Paramètres' },
      wallet: { locked: 'Portefeuille verrouillé', lockedSub: 'Déverrouillez pour voir vos actifs', manageWallet: 'Gérer', manageKeys: 'Gérer les clés', yourAddress: 'Votre adresse', assets: 'Actifs', refresh: 'Actualiser', noAssets: 'Aucun actif trouvé' },
      transaction: { title: 'Envoyer un paiement', locked: 'Portefeuille verrouillé', lockedSub: 'Déverrouillez pour envoyer', unlock: 'Déverrouiller', selectToken: 'Choisir un jeton', noTokens: 'Aucun jeton disponible', recipient: 'Destinataire', amount: 'Montant', memo: 'Note (optionnel)', send: 'Envoyer', sending: 'Envoi...', available: 'Disponible', confirmTitle: 'Confirmer la transaction', cancel: 'Annuler', send_: 'Envoyer', success: 'Transaction envoyée !', error: 'Erreur', insufficient: 'Solde insuffisant' },
      market: { title: 'Marché', subtitle: 'Prix en direct', noData: 'Aucune donnée de marché' },
      tokens: { title: 'Jetons', search: 'Rechercher par nom ou ID', noTokens: 'Aucun jeton disponible', noMatches: 'Aucun résultat', tryDifferent: 'Essayez un autre terme' },
      settings: { title: 'Paramètres', testnet: 'Testnet', testnetDesc: 'Connecter au réseau de test', serverUrl: 'URL du serveur', save: 'Enregistrer', about: 'À propos', appVersion: 'Version', network: 'Réseau', testnet_: 'Testnet', mainnet: 'Mainnet', reset: 'Réinitialiser', saved: 'Enregistré', serverUpdated: 'URL mise à jour', resetDone: 'Paramètres réinitialisés', urlEmpty: 'L\'URL ne peut pas être vide' },
      keys: { manageKeys: 'Gérer les clés', create: 'Nouveau portefeuille', saveWithPassword: 'Sauvegarder avec mot de passe', enterPassword: 'Mot de passe (min. 6 car.)', confirmPassword: 'Confirmer le mot de passe', saveWallet: 'Sauvegarder', saving: 'Sauvegarde...', setPassword: 'Définir le mot de passe', created: 'Portefeuille créé !', saved: 'Portefeuille sauvegardé !', importKey: 'Importer une clé privée', loadFile: 'Charger depuis un fichier', done: 'Terminé', back: 'Retour', cancel: 'Annuler', unlock: 'Déverrouiller', unlocking: 'Déverrouillage...', lock: 'Verrouiller', currentWallet: 'Portefeuille actuel :', unlocked: 'Déverrouillé', locked: 'Verrouillé', password: 'Mot de passe', yourAddress: 'Votre adresse :', important: 'Important : sauvegardez ce portefeuille avec un mot de passe sécurisé.' },
      sidebar: { bigt: 'bigT', home: 'Accueil' },
      common: { language: 'Langue', langAriaChange: 'Changer la langue' },
    },
  },
  es: {
    translation: {
      nav: { transaction: 'Transacción', wallet: 'Billetera', market: 'Mercado', tokens: 'Tokens', settings: 'Ajustes' },
      wallet: { locked: 'Billetera bloqueada', lockedSub: 'Desbloquee para ver sus activos', manageWallet: 'Administrar', manageKeys: 'Administrar claves', yourAddress: 'Su dirección', assets: 'Activos', refresh: 'Actualizar', noAssets: 'Sin activos' },
      transaction: { title: 'Enviar pago', locked: 'Billetera bloqueada', lockedSub: 'Desbloquee para enviar', unlock: 'Desbloquear', selectToken: 'Seleccionar token', noTokens: 'Sin tokens disponibles', recipient: 'Destinatario', amount: 'Cantidad', memo: 'Nota (opcional)', send: 'Enviar', sending: 'Enviando...', available: 'Disponible', confirmTitle: 'Confirmar transacción', cancel: 'Cancelar', send_: 'Enviar', success: '¡Transacción enviada!', error: 'Error', insufficient: 'Saldo insuficiente' },
      market: { title: 'Mercado', subtitle: 'Precios en vivo', noData: 'Sin datos de mercado' },
      tokens: { title: 'Tokens', search: 'Buscar por nombre o ID', noTokens: 'Sin tokens disponibles', noMatches: 'Sin resultados', tryDifferent: 'Intente otro término' },
      settings: { title: 'Ajustes', testnet: 'Testnet', testnetDesc: 'Conectar a red de prueba', serverUrl: 'URL del servidor', save: 'Guardar', about: 'Acerca de', appVersion: 'Versión', network: 'Red', testnet_: 'Testnet', mainnet: 'Mainnet', reset: 'Restablecer', saved: 'Guardado', serverUpdated: 'URL actualizada', resetDone: 'Ajustes restablecidos', urlEmpty: 'La URL no puede estar vacía' },
      keys: { manageKeys: 'Administrar claves', create: 'Nueva billetera', saveWithPassword: 'Guardar con contraseña', enterPassword: 'Contraseña (mín. 6 caracteres)', confirmPassword: 'Confirmar contraseña', saveWallet: 'Guardar', saving: 'Guardando...', setPassword: 'Establecer contraseña', created: '¡Billetera creada!', saved: '¡Billetera guardada!', importKey: 'Importar clave privada', loadFile: 'Cargar desde archivo', done: 'Hecho', back: 'Atrás', cancel: 'Cancelar', unlock: 'Desbloquear', unlocking: 'Desbloqueando...', lock: 'Bloquear', currentWallet: 'Billetera actual:', unlocked: 'Desbloqueada', locked: 'Bloqueada', password: 'Contraseña', yourAddress: 'Su dirección:', important: 'Importante: guarde esta billetera con una contraseña segura.' },
      sidebar: { bigt: 'bigT', home: 'Inicio' },
      common: { language: 'Idioma', langAriaChange: 'Cambiar idioma' },
    },
  },
  ja: {
    translation: {
      nav: { transaction: '取引', wallet: 'ウォレット', market: 'マーケット', tokens: 'トークン', settings: '設定' },
      wallet: { locked: 'ウォレットがロックされています', lockedSub: '資産を表示するにはロックを解除してください', manageWallet: '管理', manageKeys: 'キー管理', yourAddress: 'アドレス', assets: '資産', refresh: '更新', noAssets: '資産が見つかりません' },
      transaction: { title: '送金', locked: 'ウォレットがロックされています', lockedSub: '送金するにはロックを解除してください', unlock: 'ロック解除', selectToken: 'トークンを選択', noTokens: '利用可能なトークンがありません', recipient: '受取先', amount: '金額', memo: 'メモ（任意）', send: '送金', sending: '送信中...', available: '利用可能', confirmTitle: '取引確認', cancel: 'キャンセル', send_: '送信', success: '取引完了！', error: 'エラー', insufficient: '残高不足' },
      market: { title: 'マーケット', subtitle: 'リアルタイム価格', noData: 'マーケットデータがありません' },
      tokens: { title: 'トークン', search: '名前またはIDで検索', noTokens: '利用可能なトークンがありません', noMatches: '一致しません', tryDifferent: '別の検索語をお試しください' },
      settings: { title: '設定', testnet: 'テストネット', testnetDesc: 'テストネットワークに接続', serverUrl: 'サーバーURL', save: '保存', about: '情報', appVersion: 'アプリバージョン', network: 'ネットワーク', testnet_: 'テストネット', mainnet: 'メインネット', reset: 'デフォルトにリセット', saved: '保存しました', serverUpdated: 'サーバーURLを更新しました', resetDone: '設定をリセットしました', urlEmpty: 'サーバーURLを入力してください' },
      keys: { manageKeys: 'キー管理', create: '新規ウォレット作成', saveWithPassword: 'パスワードで保存', enterPassword: 'パスワード（6文字以上）', confirmPassword: 'パスワード確認', saveWallet: '保存', saving: '保存中...', setPassword: 'パスワード設定', created: 'ウォレット作成完了！', saved: 'ウォレット保存完了！', importKey: '秘密鍵をインポート', loadFile: 'ファイルから読み込み', done: '完了', back: '戻る', cancel: 'キャンセル', unlock: 'ロック解除', unlocking: '解除中...', lock: 'ロック', currentWallet: '現在のウォレット：', unlocked: '解除済み', locked: 'ロック中', password: 'パスワード', yourAddress: 'ウォレットアドレス：', important: '重要：このウォレットは安全なパスワードで保存してください。' },
      sidebar: { bigt: 'bigT', home: 'ホーム' },
      common: { language: '言語', langAriaChange: '言語を変更' },
    },
  },
};

export const supportedLanguages = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'zh', name: '中文', flag: '🇨🇳' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'ja', name: '日本語', flag: '🇯🇵' },
];

i18n.use(initReactI18next).init({ resources, fallbackLng: 'en', interpolation: { escapeValue: false } });

export default i18n;
