package com.abhinav.cinemasound;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Shows the Cinema Sound page (assets, from cinema-sound/web) in a WebView.
 * The page does all the sound work with the Web Audio API; this class only
 * opens the file picker and writes converted songs to Music/Cinema Sound.
 */
public class MainActivity extends Activity {
    private static final int PICK_SONG = 1;
    private static final String FOLDER = "Cinema Sound";

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("audio/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a song"), PICK_SONG);
                } catch (Exception e) {
                    pickCallback = null;
                    return false;
                }
                return true;
            }
        });

        // Android 8 and 9 need permission to save into the shared Music folder
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, 0);
        }

        web.addJavascriptInterface(new Bridge(), "CinemaAndroid");
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl("file:///android_asset/index.html");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_SONG || pickCallback == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] picked = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        pickCallback.onReceiveValue(picked);
        pickCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    /** Called from app.js. Runs on the WebView's bridge thread, not the UI thread. */
    private class Bridge {
        private OutputStream out;
        private Uri pending;   // Android 10+: the MediaStore entry being written
        private File file;     // Android 8 and 9: the file being written
        private String where;

        @JavascriptInterface
        public synchronized boolean begin(String name) {
            cancel();
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Audio.Media.DISPLAY_NAME, name);
                    v.put(MediaStore.Audio.Media.MIME_TYPE, "audio/wav");
                    v.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/" + FOLDER);
                    v.put(MediaStore.Audio.Media.IS_PENDING, 1);
                    ContentResolver r = getContentResolver();
                    pending = r.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
                    if (pending == null) return false;
                    out = r.openOutputStream(pending);
                    where = "Music/" + FOLDER;
                } else {
                    // Without the storage permission, fall back to the app's own Music folder
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), FOLDER);
                    where = "Music/" + FOLDER;
                    if ((!dir.mkdirs() && !dir.isDirectory()) || !dir.canWrite()) {
                        dir = getExternalFilesDir(Environment.DIRECTORY_MUSIC);
                        where = "Android/data/" + getPackageName() + "/files/Music";
                    }
                    file = new File(dir, name);
                    out = new FileOutputStream(file);
                }
                return out != null;
            } catch (Exception e) {
                cancel();
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean append(String base64) {
            if (out == null) return false;
            try {
                out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** Returns where the file was saved, or "" if it failed. */
        @JavascriptInterface
        public synchronized String finish() {
            if (out == null) return "";
            try {
                out.close();
                out = null;
                if (pending != null) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Audio.Media.IS_PENDING, 0);
                    getContentResolver().update(pending, v, null, null);
                    pending = null;
                }
                file = null;
                return where;
            } catch (IOException e) {
                cancel();
                return "";
            }
        }

        @JavascriptInterface
        public synchronized void cancel() {
            if (out != null) {
                try { out.close(); } catch (IOException ignored) { }
                out = null;
            }
            if (pending != null) {
                try { getContentResolver().delete(pending, null, null); } catch (Exception ignored) { }
                pending = null;
            }
            if (file != null) {
                file.delete();
                file = null;
            }
        }

        /** Keeps the screen on while a song is converting. */
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }
}
