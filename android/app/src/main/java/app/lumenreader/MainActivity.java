package app.lumenreader;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

/**
 * The page fills the screen on every Android version and WebView, and the status and
 * navigation bars are drawn over it. The page learns how much room they take from the
 * --safe-area-inset-* CSS variables. Hiding and showing the bars (the reader does this
 * with its toolbars) never resizes the page, so the book isn't laid out again; only
 * the keyboard takes room from it.
 *
 * This replaces Capacitor's insets handling (turned off in capacitor.config.ts), which
 * on WebViews older than 140 pads the page by the bars, resizing it whenever they
 * come or go.
 */
public class MainActivity extends BridgeActivity {

    private Insets bars = Insets.NONE;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        View decor = window.getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
            view.setPadding(0, 0, 0, keyboard ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0);
            int types = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets all = insets.getInsets(types);
            // the navigation bar is behind the keyboard, which already took its room
            bars = Insets.of(all.left, all.top, all.right, keyboard ? 0 : all.bottom);
            setCssInsets();
            return new WindowInsetsCompat.Builder(insets).setInsets(types, bars).build();
        });
        // a page loading after the last change of insets needs them too
        if (bridge != null) {
            bridge.addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView webView, String url) {
                    setCssInsets();
                }
            });
        }
    }

    private void setCssInsets() {
        WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView == null) return;
        float density = getResources().getDisplayMetrics().density;
        String script = String.format(
            Locale.US,
            "(s => { s.setProperty('--safe-area-inset-top', '%dpx'); s.setProperty('--safe-area-inset-right', '%dpx');" +
            " s.setProperty('--safe-area-inset-bottom', '%dpx'); s.setProperty('--safe-area-inset-left', '%dpx') })" +
            "(document.documentElement.style)",
            Math.round(bars.top / density),
            Math.round(bars.right / density),
            Math.round(bars.bottom / density),
            Math.round(bars.left / density)
        );
        webView.evaluateJavascript(script, null);
    }
}
