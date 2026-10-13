package org.stablescouncil.stables.route2;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.*;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;

/**
 * Route 2 evidence, step 2: what one exit package proves, checked from first principles (trace-design.md 13.11).
 *
 * An exit request carries the exited coin's whole history in its kept state (ports 30-39): the deposit anchors, every
 * payment hop, the attestation chain of every key that ever held part of it, and the exit line. This tool reads that
 * package offline and reports, for each step, who signed it and whether the signature holds:
 *   - every key: its Android key attestation chain up to a pinned Google root, the security level (TEE or StrongBox),
 *     the verified-boot state and the device chain it came from;
 *   - every hop: each parent coin's signature over the hop, by the key that owned that coin, and conservation;
 *   - the exit line: signed by the exited coin's own key.
 * It reads no node and trusts nothing the phone or the council said: the same bytes anyone can take from the chain.
 *
 * Usage: java -cp <checker build>:<minima.jar> org.stablescouncil.stables.route2.R2Evidence --pkg <file with hex> [--status <revoked list>]
 */
public final class R2Evidence {
    private static final String[] LEVEL={"software","TEE","StrongBox"};

    public static void main(String[] argv)throws Exception{
        Map<String,String> a=new HashMap<>();for(int i=0;i+1<argv.length;i+=2)a.put(argv[i].replaceFirst("^--",""),argv[i+1]);
        byte[] pkg=R2Codec.unhex(new String(Files.readAllBytes(Paths.get(a.get("pkg"))),StandardCharsets.US_ASCII).trim().replaceFirst("^0[xX]",""));
        Set<String> revoked=a.get("status")==null?Collections.<String>emptySet():R2Status.parse(new String(Files.readAllBytes(Paths.get(a.get("status"))),StandardCharsets.UTF_8));
        System.out.println(report(pkg,R2Attestation.production(revoked)).toString());
    }

    static JSONObject report(byte[] pkg,R2Attestation att)throws Exception{
        JSONObject out=new JSONObject();
        R2Exit.Package p=R2Exit.unpack(pkg);
        out.put("packageBytes",pkg.length);out.put("packageHash","0x"+R2Codec.hex(p.hash).toUpperCase(Locale.ROOT));
        R2Bundle b=R2Bundle.parse(p.bundle);

        // Keys: each key's attestation, checked against the pinned Google roots.
        Map<String,R2Attestation.Key> attested=new HashMap<>();
        Map<String,String> chainLabel=new LinkedHashMap<>();
        JSONArray keys=new JSONArray();
        for(R2Bundle.KeyRecord k:b.keys()){
            JSONObject o=new JSONObject();List<byte[]> chain=b.chain(k.chain);
            String cid=R2Codec.hex(R2Attestation.chainId(chain));
            if(!chainLabel.containsKey(cid))chainLabel.put(cid,"device "+(char)('A'+chainLabel.size()));
            o.put("device",chainLabel.get(cid));o.put("deviceChain","0x"+cid.toUpperCase(Locale.ROOT));
            X509Certificate leaf=cert(k.leaf);
            o.put("leafSubject",leaf.getSubjectX500Principal().getName());o.put("leafIssuer",leaf.getIssuerX500Principal().getName());
            JSONArray certs=new JSONArray();
            for(byte[] d:chain){X509Certificate c=cert(d);JSONObject co=new JSONObject();co.put("subject",c.getSubjectX500Principal().getName());
                co.put("issuer",c.getIssuerX500Principal().getName());co.put("sha256","0x"+R2Codec.hex(R2Codec.sha256(d)).toUpperCase(Locale.ROOT));certs.add(co);}
            o.put("chain",certs);
            try{
                R2Attestation.Key key=att.verifyKey(k.leaf,chain);
                attested.put(R2Codec.hex(key.keyHash),key);
                o.put("keyHash","0x"+R2Codec.hex(key.keyHash).toUpperCase(Locale.ROOT));
                o.put("publicKey","0x"+R2Codec.hex(key.point).toUpperCase(Locale.ROOT));
                o.put("attestation","accepted: chain reaches a pinned Google root");
                // verifyKey throws on the first broken rule, so an accepted key holds every one of them (trace-design 13.6).
                JSONArray rules=new JSONArray();
                rules.add("attested by secure hardware, not software");rules.add("usage count limit 1, enforced in hardware (the key signs once, then the chip destroys it)");
                rules.add("generated inside the hardware, never imported");rules.add("EC P-256 signing key");
                rules.add("bootloader locked");rules.add("verified boot: the maker's key, or a pinned GrapheneOS key");
                o.put("rules",rules);
                o.put("securityLevel",key.securityLevel>=0&&key.securityLevel<LEVEL.length?LEVEL[key.securityLevel]:String.valueOf(key.securityLevel));
                // Android KeyDescription verifiedBootState: 0 Verified (the maker's key), 1 SelfSigned (an owner-installed OS,
                // accepted only for the GrapheneOS keys the app pins), 2 Unverified, 3 Failed.
                String[] boot={"verified (manufacturer key)","self-signed","unverified","failed"};
                o.put("bootState",key.bootState>=0&&key.bootState<boot.length?boot[key.bootState]:String.valueOf(key.bootState));
                String named=key.bootKey==null?null:R2Attestation.GRAPHENEOS_BOOT_KEYS.get(key.bootKey.toLowerCase(Locale.ROOT));
                o.put("bootKey",key.bootKey==null?"":(named!=null?named+" ("+key.bootKey+")":key.bootKey));
                o.put("os",named!=null?named:(key.bootState==0?"stock Android (Google-signed boot)":"unknown"));
            }catch(R2Codec.R2Exception e){o.put("attestation","REFUSED: "+e.getMessage());}
            keys.add(o);
        }
        out.put("keys",keys);out.put("devices",chainLabel.size());

        // Coins and owners: anchored roots first, then every hop's outputs.
        Map<String,byte[]> owner=new HashMap<>();Map<String,Long> amount=new HashMap<>();
        JSONArray anchors=new JSONArray();
        for(R2Bundle.Anchor an:b.anchors()){
            String root=R2Codec.hex(an.rootId());owner.put(root,an.k0);amount.put(root,an.amount);
            JSONObject o=new JSONObject();o.put("anchorCoin","0x"+R2Codec.hex(an.coinId).toUpperCase(Locale.ROOT));
            o.put("amount",R2Codec.decimal(an.amount));o.put("token","0x"+R2Codec.hex(an.token).toUpperCase(Locale.ROOT));
            o.put("cardCoin","0x"+root.toUpperCase(Locale.ROOT));o.put("ownerKey",keyLabel(an.k0,attested,b));
            anchors.add(o);
        }
        out.put("anchors",anchors);

        JSONArray hops=new JSONArray();boolean allHops=true;int n=0;
        for(R2Hop h:b.hops()){
            JSONObject o=new JSONObject();o.put("hop",++n);
            JSONArray parents=new JSONArray();long sum=0;
            for(int i=0;i<h.parents.size();i++){
                String pid=R2Codec.hex(h.parents.get(i));byte[] ow=owner.get(pid);JSONObject po=new JSONObject();
                po.put("coin","0x"+pid.toUpperCase(Locale.ROOT));
                if(ow==null){po.put("signature","UNKNOWN PARENT");allHops=false;}
                else{
                    boolean ok=R2Codec.verify(ow,h.body,h.signature(i))&&attested.containsKey(R2Codec.hex(R2Codec.keyHash(ow)));if(!ok)allHops=false;
                    po.put("amount",R2Codec.decimal(amount.get(pid)));sum+=amount.get(pid);
                    po.put("signedBy",keyLabel(ow,attested,b));po.put("signature",ok?"valid (ECDSA P-256 over the hop body)":"INVALID");
                    po.put("signatureDer","0x"+R2Codec.hex(h.signature(i)).toUpperCase(Locale.ROOT));po.put("signerPublicKey","0x"+R2Codec.hex(ow).toUpperCase(Locale.ROOT));
                }
                parents.add(po);
            }
            o.put("spends",parents);o.put("bodyHex","0x"+R2Codec.hex(h.body).toUpperCase(Locale.ROOT));o.put("bodyBytes",h.body.length);
            String recv=R2Codec.hex(h.recvId());owner.put(recv,h.recvPub);amount.put(recv,h.recvAmount);
            JSONObject ro=new JSONObject();ro.put("coin","0x"+recv.toUpperCase(Locale.ROOT));ro.put("amount",R2Codec.decimal(h.recvAmount));ro.put("ownerKey",keyLabel(h.recvPub,attested,b));
            o.put("pays",ro);
            if(h.changePub!=null){String ch=R2Codec.hex(h.changeId());owner.put(ch,h.changePub);amount.put(ch,h.changeAmount);
                JSONObject co=new JSONObject();co.put("coin","0x"+ch.toUpperCase(Locale.ROOT));co.put("amount",R2Codec.decimal(h.changeAmount));co.put("ownerKey",keyLabel(h.changePub,attested,b));
                o.put("change",co);}
            boolean conserved=sum==h.total();if(!conserved)allHops=false;
            o.put("conservation",conserved?"in "+R2Codec.decimal(sum)+" = out "+R2Codec.decimal(h.total()):"BROKEN: in "+sum+" out "+h.total());
            hops.add(o);
        }
        out.put("hops",hops);

        R2Exit line=p.line;JSONObject ex=new JSONObject();
        String cid=R2Codec.hex(line.coinId);byte[] ow=owner.get(cid);
        ex.put("exitedCoin","0x"+cid.toUpperCase(Locale.ROOT));ex.put("amount",R2Codec.decimal(line.amount));
        ex.put("token","0x"+R2Codec.hex(line.token).toUpperCase(Locale.ROOT));ex.put("payout","0x"+R2Codec.hex(line.payout).toUpperCase(Locale.ROOT));
        boolean exitOk=ow!=null&&R2Codec.verify(ow,line.body,line.signature())&&attested.containsKey(R2Codec.hex(R2Codec.keyHash(ow)));
        ex.put("signedBy",ow==null?"UNKNOWN COIN":keyLabel(ow,attested,b));
        ex.put("bodyHex","0x"+R2Codec.hex(line.body).toUpperCase(Locale.ROOT));ex.put("signatureDer","0x"+R2Codec.hex(line.signature()).toUpperCase(Locale.ROOT));
        if(ow!=null)ex.put("signerPublicKey","0x"+R2Codec.hex(ow).toUpperCase(Locale.ROOT));
        ex.put("signature",exitOk?"valid (ECDSA P-256 over the 126-byte STR2E exit line)":"INVALID");
        ex.put("amountMatchesCoin",ow!=null&&amount.get(cid)!=null&&amount.get(cid)==line.amount);
        out.put("exit",ex);

        boolean keysOk=true;for(Object k:keys)if(!String.valueOf(((JSONObject)k).get("attestation")).startsWith("accepted"))keysOk=false;
        out.put("verdict",(keysOk&&allHops&&exitOk)?"every key attested by Google roots, every hop and the exit line validly signed":"NOT CLEAN: see the entries marked in capitals");
        return out;
    }

    /** A key named by its device and hash, and whether its attestation was accepted. */
    private static String keyLabel(byte[] point,Map<String,R2Attestation.Key> attested,R2Bundle b){
        String kh=R2Codec.hex(R2Codec.keyHash(point));R2Attestation.Key k=attested.get(kh);
        // A key with no attestation in this package owns a coin that left this history (paid on elsewhere): it never
        // signs anything here, and every key that does sign is checked to be attested.
        String lvl=k==null?"coin that left this history; its key signs nothing here":(k.securityLevel>=0&&k.securityLevel<LEVEL.length?LEVEL[k.securityLevel]:"level "+k.securityLevel)+" key";
        return "0x"+kh.toUpperCase(Locale.ROOT)+" ("+lvl+")";
    }
    private static X509Certificate cert(byte[] der)throws Exception{
        return (X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }
}
