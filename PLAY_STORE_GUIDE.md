# APSHULE Google Play Store TWA Guide

This guide packages the existing APSHULE PWA at `https://appshule.com` as a Trusted Web Activity (TWA) with the Android package name `com.apshule.app`.

## Before you begin

You need:

- A computer with Node.js and Java installed.
- Access to the APSHULE domain and GitHub Pages repository.
- A Google Play Console developer account. Google charges a one-time registration fee.
- A secure place to keep the Android signing keystore and its passwords.

Never commit the keystore or its passwords to GitHub.

## 1. Confirm the PWA is live

Open these URLs and confirm each responds successfully:

- `https://appshule.com/manifest.json`
- `https://appshule.com/.well-known/assetlinks.json`

The manifest already includes the fields needed by Bubblewrap: app name, short name, start URL, standalone display mode, theme colors, and 192×192 and 512×512 icons. The 512×512 icon is marked as maskable.

The initial `assetlinks.json` contains a placeholder fingerprint. Replace it after Bubblewrap creates the signing key. The repository also contains `.nojekyll`, which allows GitHub Pages to publish the otherwise-hidden `.well-known` directory.

## 2. Install Bubblewrap

Install the Bubblewrap command-line tool:

```bash
npm install --global @bubblewrap/cli
```

Confirm it is available:

```bash
bubblewrap --version
```

## 3. Generate the Android TWA project

Create an empty folder outside this web repository, open a terminal in it, and run:

```bash
bubblewrap init --manifest https://appshule.com/manifest.json
```

During setup:

1. Use `com.apshule.app` as the application/package ID.
2. Use `APSHULE` as the app name.
3. Keep `appshule.com` as the host.
4. Allow Bubblewrap to generate a new signing key if no APSHULE release key already exists.
5. Store the keystore and passwords securely. The same signing identity is required for future updates.

## 4. Get the SHA-256 signing fingerprint

From the generated TWA project, ask Bubblewrap for the Digital Asset Links information:

```bash
bubblewrap fingerprint
```

If that command is unavailable in your installed Bubblewrap version, use Java's keytool:

```bash
keytool -list -v -keystore PATH_TO_YOUR_KEYSTORE -alias YOUR_KEY_ALIAS
```

Copy the value labelled `SHA256`. It looks like colon-separated hexadecimal pairs.

Open `.well-known/assetlinks.json` in this repository and replace:

```text
TODO: REPLACE_WITH_BUBBLEWRAP_SHA256_CERT_FINGERPRINT
```

with the exact SHA-256 fingerprint. Keep the JSON quotes around the value.

Push the updated file, then confirm the final file is publicly available at:

```text
https://appshule.com/.well-known/assetlinks.json
```

The file must be served over HTTPS without redirects and with a JSON content type.

## 5. Build the signed Android App Bundle

Inside the generated TWA project, run:

```bash
bubblewrap build
```

Bubblewrap will request the signing-key details and produce an Android App Bundle (`.aab`) suitable for Google Play. It may also produce an APK for local testing.

Keep a backup of the generated TWA project, keystore, key alias, and passwords. Losing the signing key can prevent you from shipping updates unless Play App Signing recovery is available.

## 6. Test before uploading

Install the generated APK on an Android device or emulator and verify:

1. APSHULE opens without a browser address bar.
2. Login, navigation, live lessons, and offline PWA behavior work.
3. The app remains on `appshule.com`.
4. No Digital Asset Links verification warning appears.

If a browser toolbar appears, recheck the package name, signing fingerprint, and public `assetlinks.json` file.

## 7. Create the Play Console listing

In Google Play Console:

1. Create a new app named `APSHULE`.
2. Select the default language and choose **App** rather than **Game**.
3. Choose the appropriate free/paid setting.
4. Use `com.apshule.app` as the package name by uploading the generated AAB.
5. Complete the store listing:
   - App name and descriptions.
   - 512×512 Play Store icon.
   - Phone/tablet screenshots.
   - Feature graphic.
   - Education category and contact details.
6. Complete App content declarations, including:
   - Privacy policy.
   - Data safety.
   - Ads declaration.
   - Content rating.
   - Target audience and children-related declarations.
   - App access instructions if reviewers need a login.
7. Configure Play App Signing and save the Play signing certificate SHA-256 fingerprint.

## 8. Add the Play signing fingerprint

Google Play App Signing may use a different certificate from the local upload key. In Play Console, open **Setup → App integrity**, copy the SHA-256 fingerprint under **App signing key certificate**, and add it to the same array in `.well-known/assetlinks.json`.

The final array can contain both the local/upload fingerprint and the Play app-signing fingerprint:

```json
"sha256_cert_fingerprints": [
  "LOCAL_OR_UPLOAD_KEY_SHA256",
  "PLAY_APP_SIGNING_KEY_SHA256"
]
```

Push the updated file and verify the public URL again before production review.

## 9. Upload and submit

1. Create an Internal testing release first.
2. Upload the signed `.aab`.
3. Resolve all Play Console warnings and errors.
4. Test the Internal testing release on an Android device.
5. Promote the tested build to the required release track.
6. Submit it for Google Play review.

For every future update, rebuild with the same package name and signing setup, then increment the Android version code before uploading the new AAB.