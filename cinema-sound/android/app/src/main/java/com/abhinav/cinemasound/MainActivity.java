package com.abhinav.cinemasound;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Collections;

/**
 * Shows the Cinema Sound page (assets, from cinema-sound/web) in a WebView.
 * The page does all the sound work with the Web Audio API; this class only
 * serves the page and the phone's songs to it, opens the file picker and
 * writes converted songs to Music/Cinema Sound.
 *
 * The page is served from https://appassets.androidplatform.net (a name
 * Android reserves for this), so it can fetch /song/<id> from the same place.
 */
public class MainActivity extends Activity {
    private static final int PICK_SONG = 1;
    private static final int SONGS_PERMISSION = 2;
    private static final String FOLDER = "Cinema Sound";
    private static final String HOST = "appassets.androidplatform.net";
    // Shorter than this is a ringtone or a notification sound, not a song
    private static final int MIN_SONG_MS = 30000;

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
        s.setAllowFileAccess(false);
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

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!HOST.equals(url.getHost())) return null;
                return serve(url.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());
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
            web.loadUrl("https://" + HOST + "/index.html");
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
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != SONGS_PERMISSION) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            sendSongs();
        } else {
            web.evaluateJavascript("window.cinemaSongs(null, 'denied')", null);
        }
    }

    // Runs on a WebView thread. Serves the page from the assets, and the
    // songs found by sendSongs() as /song/<MediaStore id>.
    private WebResourceResponse serve(String path) {
        if (path == null || path.equals("/")) path = "/index.html";
        try {
            if (path.startsWith("/song/")) {
                long id = Long.parseLong(path.substring("/song/".length()));
                Uri song = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id);
                return new WebResourceResponse("application/octet-stream", null, getContentResolver().openInputStream(song));
            }
            if (path.contains("..")) return notFound();
            String ext = MimeTypeMap.getFileExtensionFromUrl(path);
            String mime = "js".equals(ext) ? "text/javascript" : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            return new WebResourceResponse(mime != null ? mime : "application/octet-stream", "utf-8", getAssets().open(path.substring(1)));
        } catch (Exception e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not found",
                Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static String songPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? Manifest.permission.READ_MEDIA_AUDIO
                : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    // Lists the songs on the phone (internal storage and SD card) and hands
    // them to the page as JSON: [{ id, title, artist, ms }]
    private void sendSongs() {
        new Thread(() -> {
            JSONArray songs = new JSONArray();
            String[] columns = {
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.DURATION,
            };
            // Leave out the songs this app made
            String where = MediaStore.Audio.Media.DURATION + " >= ? AND "
                    + MediaStore.Audio.Media.DISPLAY_NAME + " NOT LIKE ?";
            String[] args = { String.valueOf(MIN_SONG_MS), "%(Cinema).wav" };
            String problem = "";
            try (Cursor c = getContentResolver().query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                    columns, where, args, MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC")) {
                while (c != null && c.moveToNext()) {
                    String artist = c.getString(2);
                    if (artist == null || "<unknown>".equals(artist)) artist = "";
                    JSONObject song = new JSONObject();
                    song.put("id", c.getLong(0));
                    song.put("title", c.getString(1) != null ? c.getString(1) : "");
                    song.put("artist", artist);
                    song.put("ms", c.getLong(3));
                    songs.put(song);
                }
            } catch (Exception e) {
                problem = "failed";
            }
            String call = "window.cinemaSongs(" + JSONObject.quote(songs.toString()) + ", '" + problem + "')";
            runOnUiThread(() -> web.evaluateJavascript(call, null));
        }).start();
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

        /** Asks for access to music if needed, then sends the song list to window.cinemaSongs. */
        @JavascriptInterface
        public void findSongs() {
            runOnUiThread(() -> {
                if (checkSelfPermission(songPermission()) == PackageManager.PERMISSION_GRANTED) {
                    sendSongs();
                } else {
                    requestPermissions(new String[] { songPermission() }, SONGS_PERMISSION);
                }
            });
        }

        /** Opens this app's page in Android settings, to allow music access after "Don't allow". */
        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null));
                startActivity(i);
            });
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
