package org.stablescouncil.stables.route2;

/*
 * SKELETON ONLY (2026-11-03). Not in the app tree, not compiled, not in any APK. It shows where the guardian mode plugs
 * into Stables and what each step reuses; android/README.md says how it would land. The rules are guardian-core.mjs's,
 * one for one, so the phone and the PC decide alike; the shared test fixtures check both once this is real.
 *
 * Where it runs: inside the app's process, on a thread the built-in node's foreground service already keeps alive
 * (org.minimarex.minimacore.service.MinimaService, startForeground). No second service and no second notification.
 * When: every 5 minutes while the mode is on AND (charging on an unmetered network, R2Engine.charging/unmetered, as
 * "Help other phones" does) - or always, for a phone that lives on its charger (the spare). Never through a node app in
 * this version: a guardian's key must sit in a node it controls, and CommandPolicy keeps signing commands out of
 * Minima Core on purpose.
 */
import android.content.Context;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

public final class GuardianMode {
    static final String TAG = "StablesWeb";            // the tag release builds log on; lines start [STABLES-GUARDIAN]
    static final long PASS_MS = 5 * 60_000L;

    /** On only with the built-in node, the guardian setting on, and a seat whose key this node's wallet holds. */
    static boolean enabled(Context c) {
        // TODO: settings "guardianMode" (off by default), NodeMode.INTERNAL only, seat and public key from settings.
        return false;
    }

    /** Started once by MinimaService after NodeBoot.isStartUpComplete(); stops itself when the mode is turned off. */
    public static void start(Context c) {
        Thread t = new Thread(() -> {
            for (;;) {
                try {
                    if (enabled(c) && (alwaysOn(c) || (R2Engine.charging(c) && R2Engine.unmetered(c)))) pass(c);
                } catch (Throwable e) { Log.w(TAG, "[STABLES-GUARDIAN] pass failed: " + e.getMessage()); }
                try { Thread.sleep(PASS_MS); } catch (InterruptedException e) { return; }
            }
        }, "stables-guardian");
        t.setDaemon(true);
        t.start();
    }

    static boolean alwaysOn(Context c) { return false; /* TODO: the "phone stays on its charger" choice */ }

    /** One pass, as guardian.mjs pass(): reads, checks, decides, acts, logs. */
    static void pass(Context c) throws Exception {
        R2Node.Commands node = R2Engine.commands(c, org.stablescouncil.stables.NodeMode.INTERNAL, null);  // R2Engine.internalRead: 30 s per read
        long tip = node.run("status").getJSONObject("response").getJSONObject("chain").getLong("block");
        JSONArray head = node.run("coins address:" + R2Deposits.r2t5().headAddress()).getJSONArray("response");      // TODO accessor
        JSONArray requests = node.run("coins address:" + R2Deposits.r2t5().requestAddress()).getJSONArray("response");
        // 1. Package check: the same classes R2Checker wraps (R2Receiver.checkExit / checkRefund with R2Attestation and the
        //    node's AnchorView), called in process: no JVM to start, no RPC port. TODO: lift R2Checker.main's body into
        //    R2Receiver (one method both call) so the Council, the PC guardian and the phone run one code path.
        // 2. Decide: GuardianRules.decideRequest / rebuildRoot / checkInDue, a Java copy of guardian-core.mjs.
        // 3. Act: a stop or a check-in built with txncreate..txnbasics on the built-in node; the guardian key signs once
        //    (write-ahead WOTS journal in getNoBackupFilesDir()/guardian/wots-journal.jsonl first); txncheck must show all
        //    four checks; posted only when the person turned "act" on. Freezes are never signed here: prepared, shown.
        // 4. Log: the public log (hash-chained JSON lines) in getNoBackupFilesDir()/guardian/, shared from the page.
        // 5. Alert: an Android notification on the existing channel, and the page's Activity row "Guardian".
        Log.i(TAG, "[STABLES-GUARDIAN] pass tip " + tip + " head " + head.length() + " open " + requests.length());
    }
}
