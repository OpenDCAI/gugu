package app.gugu.chat;

import android.Manifest;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/** Read/request Android microphone permission without opening the microphone or recording audio. */
@CapacitorPlugin(name = "GuguAudioPermissions", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class GuguAudioPermissionsPlugin extends Plugin {}
