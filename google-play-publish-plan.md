# Google Play Store 发布计划 — Bapp

## 1. 前置修复（阻塞项）

- [ ] **修复 MainNetParams EC/PQ 密钥不匹配**（Issue #7）
  - 当前限制：`MainNetParams` 使用旧版 EC 公钥，与后量子密钥系统不兼容
  - 影响：应用仅可在 `Test` 网络运行，无法在主网上使用
  - 需要修改 Java 区块链服务端的根权限密钥，使其同时支持 EC 和 PQ 密钥

## 2. 应用配置

- [ ] **更改 Android 包名**
  - 当前：`com.example.bapp`（占位符）
  - 需改为真实域名，如 `com.bigtangle.bapp` 或 `ai.bigt.bapp`
  - 修改位置：`expo-app/app.config.js` 中的 `android.package`

- [ ] **更新应用版本号**
  - 当前：`1.0.0`
  - 按语义化版本规则设置初始版本，如 `1.0.0`

- [ ] **生成应用图标资源**
  - 需要准备：`icon.png`（1024x1024）、`icon-adaptive-foreground.png`、`icon-adaptive-background.png`、`icon-monochrome.png`、`icon-notification.png`
  - 放到 `expo-app/assets/` 目录
  - 在 `app.config.js` 中配置对应路径

- [ ] **生成启动屏图片**
  - 需要准备 `splash.png` 或 `splash-dark.png`
  - 在 `app.config.js` 中配置

- [ ] **更新 Target SDK**
  - 当前：API 33
  - 建议升级到 API 34（Android 14），满足 Play Store 最新要求

## 3. Google Play 开发者账号

- [ ] **注册 Google Play 开发者账号**
  - 访问 https://play.google.com/console/signup
  - 费用：一次性 $25 USD
  - 需 Google 账号

- [ ] **创建 Google Cloud Platform 项目**
  - 用于 Google Play Android Developer API
  - 关联 Play Console 账号

- [ ] **创建 Google 服务账号**
  - 在 GCP IAM 中创建服务账号
  - 授予 `发布商` 角色
  - 生成 JSON 密钥文件
  - 保存到 `expo-app/secrets/google-service-account.json`

## 4. 构建与签名

- [ ] **生成应用签名密钥（Upload Key）**
  - 使用 `keytool` 生成 `.keystore` 或 `.pepk` 文件
  - 密钥有效期建议 25+ 年
  - 安全保存密钥文件及密码

- [ ] **配置 EAS Build**
  - 运行 `npx eas build:configure`
  - 在 `eas.json` 中配置 `android.buildType: "app-bundle"`（已配置）
  - 在 EAS 项目中上传密钥库或使用 EAS 管理签名

- [ ] **生成 AAB 构建**
  - 命令：`npx eas build --platform android --profile production`
  - 输出：`.aab` 文件（Android App Bundle）

## 5. Play Console 上架

- [ ] **创建应用列表**
  - 应用名称：Bapp
  - 默认语言：中文（或英文）
  - 应用或游戏：应用
  - 选择免费或付费

- [ ] **填写应用详情**
  - 简短描述（80 字内）
  - 完整描述（4000 字内）
  - 截图：至少 2 张手机截图（16:9 或 9:16）、1 张 7 寸平板截图、1 张 10 寸平板截图
  - 应用图标：512x512
  - 特色图：1024x500
  - 分类：金融（Finance）
  - 标签：区块链、钱包、加密货币

- [ ] **设置定价与分发**
  - 国家/地区：选择目标市场
  - 广告声明：无广告

- [ ] **完成内容评级**
  - 填写调查问卷
  - 通常分级为 PEGI 3 / ESRB Everyone

- [ ] **设置应用内商品**（如有）

## 6. 隐私与合规

- [ ] **编写隐私政策**
  - 说明收集哪些数据（极小：仅 `ACCESS_NETWORK_STATE`）
  - 可使用隐私政策生成器或自备
  - 托管在网站上（如 `https://bigt.ai/privacy`）
  - 在 Play Console 中填写 URL

- [ ] **声明加密使用**
  - 应用使用加密（scrypt 加密钱包、HTTPS）
  - 在 Play Console 如实声明

- [ ] **数据安全部分**
  - 填写 Play Console 的数据安全表格
  - 说明不收集个人身份信息

## 7. 测试与发布

- [ ] **内部测试（Internal Testing）**
  - Play Console 中创建内部测试轨道
  - 上传 AAB
  - 添加测试者邮箱（最多 100 人）
  - 已配置 `eas.json` 中 `track: "internal"`

- [ ] **封闭测试（Closed Testing）**
  - 创建封闭测试轨道
  - 添加测试者列表（最多 2000 人）
  - 至少运行 14 天，收集反馈
  - **注意**：Play Store 要求新账号发布前必须有封闭测试阶段

- [ ] **开放测试（Open Testing）**
  - 可选，可跳过直接进入正式版

- [ ] **正式版发布（Production）**
  - 将 AAB 提升到正式版轨道
  - 分阶段发布（Staged Rollout）：建议初始 5-10%

## 8. CI/CD 配置

- [ ] **设置 GitHub Secrets**
  - `EXPO_TOKEN`：Expo 访问令牌
  - `GOOGLE_SERVICE_ACCOUNT`：Google 服务账号 JSON 内容（或密钥路径）

- [ ] **验证 `publish.yml` 工作流**
  - 确认自动构建和发布流程正常
  - 推送 tag `v1.0.0` 触发发布

## 9. 发布后

- [ ] **监控崩溃率**
  - 使用 Google Play 崩溃报告
  - 关注 Android Vitals

- [ ] **收集用户反馈**
- [ ] **规划 v1.0.1 修复与功能迭代**

---

## 预计时间线

| 阶段 | 预计时间 |
|---|---|
| 前置修复（MainNet 兼容） | 1-2 周 |
| 配置准备（包名、图标等） | 1-2 天 |
| 开发者账号注册 | 1 天（审核 48h） |
| 生成构建 | 1 天 |
| 测试期（封闭测试） | 14 天 |
| 正式发布 | 1 天 |

**总计**：约 3-4 周（取决于 MainNet 修复进度）
