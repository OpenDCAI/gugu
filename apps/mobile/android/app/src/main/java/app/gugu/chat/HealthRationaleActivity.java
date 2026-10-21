package app.gugu.chat;

import android.app.Activity;
import android.os.Bundle;
import android.util.TypedValue;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * #7199 健康:Health Connect 授权页上「隐私权政策」那个链接点进来的一页(系统要求必须有,没有它系统不给授权)。
 * 只说清咕咕拿健康数据做什么,❌ 再引导任何操作。
 */
public class HealthRationaleActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle(R.string.health_rationale_title);
        TextView text = new TextView(this);
        text.setText(R.string.health_rationale_body);
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        int pad = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 20, getResources().getDisplayMetrics());
        text.setPadding(pad, pad, pad, pad);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(text);
        setContentView(scroll);
    }
}
