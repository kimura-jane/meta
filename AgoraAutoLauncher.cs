using UnityEngine;
using Agora.Rtc;

public class AgoraAutoLauncher : MonoBehaviour
{
    // ▼ここにあなたのApp IDを入れてください
    private string appId = "be3dfbd19aea4850bb9564c05248f3f9";
    private string channelName = "metaverse_room_mobile";

    private static IRtcEngine _rtcEngine;

    // ★この呪文のおかげで、ゲーム開始時に勝手に起動します（配置不要）
    [RuntimeInitializeOnLoadMethod]
    static void AutoStart()
    {
        GameObject go = new GameObject("AgoraManager");
        go.AddComponent<AgoraAutoLauncher>();
        DontDestroyOnLoad(go);
    }

    void Start()
    {
        if (string.IsNullOrEmpty(appId)) return;
        SetupAgora();
    }

    void SetupAgora()
    {
        _rtcEngine = RtcEngine.CreateAgoraRtcEngine();
        RtcEngineContext context = new RtcEngineContext();
        context.appId = appId;
        context.channelProfileType = CHANNEL_PROFILE_TYPE.CHANNEL_PROFILE_LIVE_BROADCASTING;
        context.audioScenario = AUDIO_SCENARIO_TYPE.AUDIO_SCENARIO_GAME_STREAMING;
        _rtcEngine.Initialize(context);

        // 高音質設定 (SYNCROOM風)
        _rtcEngine.SetAudioProfile(AUDIO_PROFILE_TYPE.AUDIO_PROFILE_MUSIC_HIGH_QUALITY, AUDIO_SCENARIO_TYPE.AUDIO_SCENARIO_GAME_STREAMING);
        _rtcEngine.SetClientRole(CLIENT_ROLE_TYPE.CLIENT_ROLE_BROADCASTER);
        _rtcEngine.EnableAudio();
        _rtcEngine.JoinChannel("", channelName, "");
        
        Debug.Log("スマホからAgora接続成功！");
    }

    void OnDestroy()
    {
        if (_rtcEngine != null)
        {
            _rtcEngine.LeaveChannel();
            _rtcEngine.Dispose();
            _rtcEngine = null;
        }
    }
}
