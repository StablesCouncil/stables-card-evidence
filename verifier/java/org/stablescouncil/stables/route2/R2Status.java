package org.stablescouncil.stables.route2;

import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Google's attestation status list (https://android.googleapis.com/attestation/status) reduced to its revoked serials.
 * Entries are keyed by serial, written in hex or decimal; both readings are kept and the verifier checks both.
 * Any copy works: a stale list only weakens the check, it never blocks a payment (trace-design.md 13.10).
 */
public final class R2Status {
    private static final Pattern ENTRY=Pattern.compile("\"([0-9A-Fa-f]{1,64})\"\\s*:\\s*\\{([^}]*)\\}");
    private R2Status(){}
    public static Set<String> parse(String json){
        Set<String> s=new HashSet<>();
        Matcher m=ENTRY.matcher(json);
        while(m.find())if(m.group(2).contains("\"REVOKED\"")||m.group(2).contains("\"SUSPENDED\""))s.add(m.group(1).toLowerCase(Locale.ROOT));
        return Collections.unmodifiableSet(s);
    }
}
