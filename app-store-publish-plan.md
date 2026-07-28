# App Store 发布计划 — bigt.ai

## 1. 前置修复

与 Android 相同，发布前需先解除 MainNet 阻塞：
- [ ] 修复 `MainNetParams` EC/PQ 密钥不匹配（Issue #7）
- [ ] 替换占位符 bundle ID `com.example.bapp` 为真实域名

## 2. Apple 开发者账号

- [ ] **注册 Apple Developer Program**
  - 费用：$99/年
  - 地址：https://developer.apple.com/programs/enroll/
  - 需要 Apple ID
  - 个人或组织账号，组织需提供 D-U-N-S 编号
- [ ] **记录 Team ID**
  - 在 Apple Developer 后台 -> Membership 查看
  - 填入 `eas.json` 的 `appleTeamId`

## 3. App Store Connect 配置

- [ ] **创建 App 记录**
  - 登录 https://appstoreconnect.apple.com
  - 点 "+" -> 新建 App
  - 平台：iOS
  - 名称：bigt.ai
  - 语言：Simplified Chinese（或 English）
  - Bundle ID：选择或创建（如 `com.bigtangle.bapp`）
  - SKU：`BIGTAI_001`
  - **记录 App ID**（`ascAppId`），填入 `eas.json`
- [ ] **创建 Bundle ID**
  - 在 Apple Developer -> Certificates, Identifiers & Profiles
  - 创建 Explicit Bundle ID（与 `app.config.js` 中的 `ios.bundleIdentifier` 一致）
  - 启用 Capabilities（如需 Push Notifications）

## 4. 证书与签名

- [ ] **生成分发证书（Distribution Certificate）**
  - 由 EAS Build 自动管理，或手动通过 Xcode 生成
  - 如果使用 EAS：`npx eas credentials --platform ios`
- [ ] **生成配置文件（Provisioning Profile）**
  - App Store Distribution Profile
  - EAS Build 可自动管理
- [ ] **创建 App Store Connect API Key**（可选，用于 CI/CD）
  - 在 App Store Connect -> Users and Access -> Keys
  - 生成 Key，下载 `.p8` 文件
  - 权限：`Admin` 或 `App Manager`

## 5. 应用配置

- [ ] **更改 Bundle ID**
  - 修改 `expo-app/app.config.js` 中 `ios.bundleIdentifier`
- [ ] **生成应用图标**
  - 需要 `icon.png`（1024x1024，无圆角）
  - App Store 会自行生成圆角
  - 放到 `expo-app/sources/assets/images/`
- [ ] **生成启动屏**
  - `splash.png`（已配置 `expo-splash-screen` 插件）
- [ ] **确认 Info.plist 权限说明**
  - `NSMicrophoneUsageDescription`：已配置
  - `NSLocalNetworkUsageDescription`：已配置
  - `NSBonjourServices`：已配置

## 6. 加密合规声明

- [ ] **确认 `usesNonExemptEncryption: false`**
  - 已配置在 `app.config.js` 中
  - 应用使用 HTTPS 和 Scrypt 加密，属于豁免范围
  - 提交到 App Store 时需上传合规证明文件（或勾选豁免）

## 7. 构建

- [ ] **生成构建**
  ```bash
  npx eas build --platform ios --profile production
  ```
  - 输出：`.ipa` 文件
- [ ] **或通过 Xcode 构建**
  - `npx expo prebuild --platform ios`
  - 用 Xcode 打开 `ios/`，选择 `Any iOS Device (arm64)`
  - Product -> Archive

## 8. App Store Connect 填写

- [ ] **应用信息**
  - 名称：bigt.ai
  - 副标题（可选）
  - 隐私政策 URL：需托管（如 `https://bigt.ai/privacy`）
  - 类别：Finance
- [ ] **截图**
  - 6.5 寸 iPhone 截图：至少 1 张（建议 4-6 张）
  - 5.5 寸 iPhone 截图：可选
  - iPad 截图（如果支持 iPad）：12.9 寸至少 1 张
  - 格式：JPG 或 PNG，不能有透明通道
- [ ] **描述**
  - 英文描述（4000 字内）
  - 中文描述（4000 字内）
- [ ] **关键词**
  - 如：blockchain, wallet, crypto, bigtangle, bigt.ai
- [ ] **支持 URL**
  - 如 `https://bigt.ai`
- [ ] **营销 URL**（可选）
- [ ] **版本信息**
  - 版本号：`1.0.0`
  - 构建号：对应 EAS 构建号
- [ ] **App Review 信息**
  - 登录账号（如需要）：提供测试钱包信息
  - 联系方式
  - 备注

## 9. 隐私与合规

- [ ] **隐私政策**
  - 托管在网页上
  - 填写隐私政策 URL
- [ ] **App Store 隐私标签**
  - 填写数据收集问卷
  - 应用不收集个人数据，仅 `ACCESS_NETWORK_STATE`
- [ ] **出口合规**
  - 使用加密（HTTPS + Scrypt）
  - 在提交时需申报或提交 ERN/SNAP-R 合规文件
  - 已声明 `usesNonExemptEncryption: false`，可声明豁免

## 10. 提交审核

- [ ] **在 App Store Connect 中选择构建版本**
- [ ] **点击 "提交审核"**
- [ ] **审核周期**
  - 通常 1-3 天
  - 可申请加急审核（需充分理由）

## 11. CI/CD 配置

- [ ] **设置 EAS Submit**
  ```bash
  npx eas submit --platform ios --profile production
  ```
- [ ] **或配置 GitHub Actions 自动提交**
  - 在 `publish.yml` 中添加 iOS 提交步骤
  - 需要 secrets：`APPLE_ID`、`APPLE_TEAM_ID`、`ASC_APP_ID`
  - 推荐使用 App Store Connect API Key 而非交互式登录

- [ ] **在 `eas.json` 中填写**
  ```json
  "ios": {
    "appleId": "your-apple-id@example.com",
    "ascAppId": "your-app-store-connect-app-id",
    "appleTeamId": "your-apple-team-id"
  }
  ```

## 12. 发布后

- [ ] **监控崩溃**（Xcode Organizer / App Store Connect）
- [ ] **回复用户评论**
- [ ] **准备下一版本**

---

## 预计时间线

| 阶段 | 预计时间 |
|---|---|
| 前置修复 | 1-2 周 |
| 开发者账号注册 | 1-7 天（组织账号需 D-U-N-S） |
| 配置与构建 | 1-2 天 |
| App Store Connect 填写 | 1 天 |
| 审核 | 1-3 天 |
| 发布 | 立即 |

**总计**：约 2-4 周

## 与 Android 的差异

| 项目 | Android | iOS |
|---|---|---|
| 开发者费用 | $25（一次性） | $99/年 |
| 构建产物 | AAB | IPA |
| 签名 | Upload Key + Play 签名 | Distribution Certificate |
| 测试 | 内部/封闭/开放轨道 | TestFlight |
| 审核 | 通常即时到几小时 | 1-3 天 |
| 加密声明 | 数据安全表格 | 出口合规 + 加密声明 |
| 图标 | 自适应图标分层 | 1024x1024 无圆角 |
