package app.gugu.chat;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Uri;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 安卓的应用内更新 —— 这一层只做搬运:问清单、下包、把包交给系统安装器。
 *
 * 判据一条都不在这里:追哪条线、目标认不认、状态往不往回退、本地留哪个包,全在
 * apps/desktop/src/platform/capacitorAppUpdate.ts,它与桌面主进程共用 shared/update-policy.ts。
 * 这边只报三样只有原生才知道的事实(装着的版本、这个包跟哪条线、是不是正式发行的包)。
 *
 * 下好的包按 `<版本>_<sha256>.apk` 存:文件名只在 sha256 与大小都对上之后才出现
 * (先写 .part、校验完再改名),所以「目录里有这个名字」= 「这一版已经完整下好」,
 * 重开应用、界面重载都找得回来(product spec:「已经下好、等你按一下」必须一直找得回来)。
 */
@CapacitorPlugin(name = "GuguAppUpdate")
public class GuguAppUpdatePlugin extends Plugin {
    // res/xml/file_paths.xml 里 app_update 那一行把这个目录开放给安装器读,两处要一起改。
    private static final String DIR = "app-update";
    private static final Pattern VERSION = Pattern.compile("^[0-9A-Za-z.+-]+$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern PACKAGE = Pattern.compile("^([0-9A-Za-z.+-]+)_([0-9a-f]{64})\\.apk$");
    private static final int MANIFEST_MAX_BYTES = 1024 * 1024;

    // Capacitor 所有插件调用排在同一条线程上。一次几十 MB 的下载要是也在那条线程上跑,
    // 登录态读写、通知这些调用就全堵在它后面 —— 网络一律挪出去。
    private final ExecutorService io = Executors.newCachedThreadPool();
    // 下载单独一条线、一个接一个跑:页面重载会丢掉页面那边「正在下」的记忆,而原生这边的下载还在跑,
    // 重载后的下一次检查会再发一次下载。排队之后第二次开始时第一次已经结束 —— 同一版直接命中已下好的
    // 文件,别的版本也不会删掉、改名别人写到一半的 .part。
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();

    private File dir() {
        return new File(getContext().getFilesDir(), DIR);
    }

    /** 文件名就是身份:版本号与 sha256 都必须是认得出的形状,❌ 让调用方拼出目录外的路径。 */
    private File packageFile(PluginCall call) {
        String version = call.getString("version");
        String sha256 = call.getString("sha256");
        if (version == null || !VERSION.matcher(version).matches()) {
            call.reject("Invalid update version: " + version);
            return null;
        }
        if (sha256 == null || !SHA256.matcher(sha256).matches()) {
            call.reject("Invalid update sha256: " + sha256);
            return null;
        }
        return new File(dir(), version + "_" + sha256 + ".apk");
    }

    @PluginMethod
    public void identity(PluginCall call) {
        JSObject result = new JSObject();
        result.put("version", BuildConfig.VERSION_NAME);
        result.put("channel", BuildConfig.GUGU_UPDATE_CHANNEL);
        result.put("distribution", BuildConfig.GUGU_BUILD_DISTRIBUTION);
        call.resolve(result);
    }

    /**
     * 取这条线的清单原文。地址是打包时烘进来的(build.gradle @@@android-update-channel),
     * ❌ 不收调用方给的地址 —— 这不是一个通用的抓网页接口。
     * 放在原生这边取是因为下载站不发 CORS 头,页面(https://localhost)自己取会被浏览器层拦掉(DownloadSite)。
     */
    @PluginMethod
    public void fetchManifest(PluginCall call) {
        io.execute(() -> {
            try {
                // 报错照旧是这一句(classifyUpdateError 原样给人看的那句)。
                byte[] body = DownloadSite.read(BuildConfig.GUGU_UPDATE_MANIFEST_URL, MANIFEST_MAX_BYTES, "update manifest is larger than 1 MiB", null);
                JSObject result = new JSObject();
                result.put("text", new String(body, StandardCharsets.UTF_8));
                call.resolve(result);
            } catch (Exception error) {
                call.reject(DownloadSite.describe(error), error);
            }
        });
    }

    /** 走流量还是 Wi-Fi —— 走流量时不替用户做主去下几十 MB。没有网络时系统也答 metered。 */
    @PluginMethod
    public void networkMetered(PluginCall call) {
        ConnectivityManager connectivity = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        JSObject result = new JSObject();
        result.put("metered", connectivity.isActiveNetworkMetered());
        call.resolve(result);
    }

    @PluginMethod
    public void listDownloads(PluginCall call) {
        JSArray downloads = new JSArray();
        File[] files = dir().listFiles();
        if (files != null) {
            for (File file : files) {
                Matcher match = PACKAGE.matcher(file.getName());
                if (!match.matches()) continue;
                JSObject entry = new JSObject();
                entry.put("version", match.group(1));
                entry.put("sha256", match.group(2));
                downloads.put(entry);
            }
        }
        JSObject result = new JSObject();
        result.put("downloads", downloads);
        call.resolve(result);
    }

    @PluginMethod
    public void deleteDownload(PluginCall call) {
        File file = packageFile(call);
        if (file == null) return;
        if (file.exists() && !file.delete()) {
            call.reject("Could not delete " + file.getName());
            return;
        }
        call.resolve();
    }

    /**
     * 下一个包:边下边算 sha256,大小与哈希都对上才改名成正式文件名,任何一样不对就删掉半截、报错。
     * 进度按整数百分比变化时推一次 `downloadProgress`。已经下好的同一份直接返回,不重下。
     */
    @PluginMethod
    public void download(PluginCall call) {
        File target = packageFile(call);
        if (target == null) return;
        String url = call.getString("url");
        // ❌ call.getLong:页面传来的数字在 JSONObject 里按大小存成 Integer 或 Long,getLong 只认 Long,
        // 几十 MB 的包(装得进 int)就读成 null(2026-09-22 模拟器实测)。optLong 按数值读。
        long size = call.getData().optLong("size", -1);
        if (url == null || !url.startsWith("https://")) {
            call.reject("Invalid update url: " + url);
            return;
        }
        if (size <= 0) {
            call.reject("Invalid update size: " + call.getData().opt("size"));
            return;
        }
        String sha256 = call.getString("sha256");
        downloads.execute(() -> {
            File directory = dir();
            if (!directory.isDirectory() && !directory.mkdirs()) {
                call.reject("Could not create " + directory);
                return;
            }
            if (target.isFile()) {
                call.resolve();
                return;
            }
            // 上一次断在半路的残留:下载在 downloads 这条线上逐个跑,轮到这里时不会有活着的 .part。
            File[] leftovers = directory.listFiles((unused, name) -> name.endsWith(".part"));
            if (leftovers != null) for (File leftover : leftovers) leftover.delete();

            File partial = new File(directory, target.getName() + ".part");
            HttpURLConnection connection = null;
            try {
                connection = DownloadSite.open(url);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long received = 0;
                long lastPercent = -1;
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buffer)) != -1) {
                        out.write(buffer, 0, n);
                        digest.update(buffer, 0, n);
                        received += n;
                        if (received > size) {
                            throw new IOException("integrity check failed: more than the " + size + " bytes the manifest lists");
                        }
                        long percent = received * 100 / size;
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject progress = new JSObject();
                            progress.put("percent", percent);
                            progress.put("transferred", received);
                            progress.put("total", size);
                            notifyListeners("downloadProgress", progress);
                        }
                    }
                }
                if (received != size) {
                    throw new IOException("integrity check failed: got " + received + " bytes, the manifest lists " + size);
                }
                String actual = hex(digest.digest());
                if (!actual.equals(sha256)) {
                    throw new IOException("integrity check failed: sha256 " + actual + " is not the listed " + sha256);
                }
                if (!partial.renameTo(target)) throw new IOException("Could not move the download into " + target.getName());
                call.resolve();
            } catch (Exception error) {
                partial.delete();
                call.reject(DownloadSite.describe(error), error);
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    /**
     * 把下好的包交给系统安装器。系统会先问用户一次(第一次还要允许咕咕「安装未知应用」),
     * 这一步只有用户按得了 —— 不经应用商店的包,安卓不让应用自己悄悄换掉自己。
     * 装成功时这个进程被系统换掉,回调走不到;走到回调 = 这次没装上(多半是用户点了取消)。
     */
    @PluginMethod
    public void install(PluginCall call) {
        File apk = packageFile(call);
        if (apk == null) return;
        if (!apk.isFile()) {
            call.reject("Update package not found: " + apk.getName());
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
        intent.setData(uri);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.putExtra(Intent.EXTRA_RETURN_RESULT, true);
        startActivityForResult(call, intent, "installResult");
    }

    @ActivityCallback
    private void installResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_OK) {
            call.resolve();
            return;
        }
        call.reject("Update was not installed (installer result " + result.getResultCode() + ")", "INSTALL_NOT_COMPLETED");
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }
}
