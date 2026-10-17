package org.stablescouncil.stables.route2;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.*;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;
import org.minima.utils.json.parser.JSONParser;

/**
 * The test council's checker for one R2T2 exit request (COUNCIL_ATTESTATION_DESIGN.md 3.1 step 2 and 6c; trace-design.md
 * 13.11). A council member reads everything from its own node: the request coin and the package in its ports, every
 * anchor of the coin's history and that anchor's deposit transaction. The checks are the app's own pure Java verifier
 * (R2Receiver.checkExit, R2Attestation, R2Anchors); this class only reads the node and compares the request ports.
 *
 *   java -cp minima.jar;classes org.stablescouncil.stables.route2.R2Checker --rpc 9105 --request 0x.. --reqaddr 0x..
 *        --anchor 0x.. --vault 0x.. --r2t1 0x.. --status attestation-status.json [--exited a,b]
 * Prints one JSON verdict: approve or reject, with a code.
 */
public final class R2Checker {
    static int port;
    static JSONObject rpc(String command)throws Exception{
        HttpURLConnection c=(HttpURLConnection)new URL("http://127.0.0.1:"+port+"/").openConnection();
        c.setRequestMethod("POST");c.setDoOutput(true);c.setConnectTimeout(30000);c.setReadTimeout(180000);
        try(OutputStream o=c.getOutputStream()){o.write(command.getBytes(StandardCharsets.UTF_8));}
        ByteArrayOutputStream b=new ByteArrayOutputStream();
        try(InputStream in=c.getInputStream()){byte[] buf=new byte[65536];int n;while((n=in.read(buf))>0)b.write(buf,0,n);}
        JSONObject r=(JSONObject)new JSONParser().parse(new String(b.toByteArray(),StandardCharsets.UTF_8));
        if(!Boolean.TRUE.equals(r.get("status")))throw new IllegalStateException("node refused "+command.split(" ")[0]+": "+r.get("error"));
        return r;
    }
    static JSONObject coin(String id)throws Exception{
        JSONArray a=(JSONArray)rpc("coins coinid:"+id).get("response");
        for(Object o:a){JSONObject c=(JSONObject)o;if(R2Anchors.eq((String)c.get("coinid"),id))return c;}
        return null;
    }
    static Map<Integer,String> state(JSONObject c){
        Map<Integer,String> s=new HashMap<>();Object raw=c.get("state");
        if(raw instanceof JSONArray)for(Object o:(JSONArray)raw){JSONObject p=(JSONObject)o;s.put(((Number)p.get("port")).intValue(),String.valueOf(p.get("data")));}
        return s;
    }
    static long tip()throws Exception{return Long.parseLong(String.valueOf(((JSONObject)((JSONObject)rpc("status").get("response")).get("chain")).get("block")));}

    /** Deposit transactions at the anchor address, read once (all of them in one node reply). */
    static List<R2Anchors.Tx> deposits;
    static List<R2Anchors.Tx> deposits(String anchorAddress)throws Exception{
        if(deposits!=null)return deposits;
        deposits=new ArrayList<>();Object r=rpc("txpow address:"+anchorAddress).get("response");
        JSONArray list=r instanceof JSONArray?(JSONArray)r:new JSONArray();if(r instanceof JSONObject)list.add(r);
        for(Object o:list){
            JSONObject txn=(JSONObject)((JSONObject)((JSONObject)o).get("body")).get("txn");
            List<R2Anchors.TxOut> outs=new ArrayList<>();List<String> ins=new ArrayList<>();
            for(Object x:(JSONArray)txn.get("outputs")){JSONObject t=(JSONObject)x;
                outs.add(new R2Anchors.TxOut((String)t.get("address"),(String)t.get("tokenid"),String.valueOf(t.get("tokenamount")),(String)t.get("coinid"),Boolean.TRUE.equals(t.get("storestate"))));}
            for(Object x:(JSONArray)txn.get("inputs"))ins.add((String)((JSONObject)x).get("address"));
            deposits.add(new R2Anchors.Tx(outs,ins));
        }
        return deposits;
    }

    /* Every hand-over the Council has seen in a package it approved (founder 2026-10-17, item 4: "catch a double payment
       from a broken chip at exit"). A hop is valid only with the one-use signature of each coin it spends, so a different
       hop spending a coin already seen here is a double spend by that coin's chip: the package is refused, with both hops
       as the proof. One line per spent coin: parent coin id, the spending hop's body hash, its signed wire (hex). */
    static final Map<String,String> seenBody=new HashMap<>(),seenWire=new HashMap<>();
    static void loadSeen(String file)throws Exception{
        if(file==null||!Files.exists(Paths.get(file)))return;
        for(String line:Files.readAllLines(Paths.get(file),StandardCharsets.UTF_8)){
            String[] f=line.trim().split(" ");if(f.length!=3)continue;
            seenBody.putIfAbsent(f[0],f[1]);seenWire.putIfAbsent(f[1],f[2]);
        }
    }
    static void recordSeen(String file,byte[] bundle){
        if(file==null||bundle==null)return;
        try{
            StringBuilder add=new StringBuilder();
            for(R2Hop h:R2Bundle.parse(bundle).hops()){
                String body=R2Codec.hex(h.bodyHash()),wire=R2Codec.hex(h.wire());
                for(byte[] par:h.parents){String pid=R2Codec.hex(par);if(seenBody.putIfAbsent(pid,body)==null){seenWire.putIfAbsent(body,wire);add.append(pid).append(' ').append(body).append(' ').append(wire).append('\n');}}
            }
            if(add.length()>0)Files.write(Paths.get(file),add.toString().getBytes(StandardCharsets.UTF_8),java.nio.file.StandardOpenOption.CREATE,java.nio.file.StandardOpenOption.APPEND);
        }catch(Exception e){System.err.println("seen hops not recorded: "+e);}
    }

    public static void main(String[] argv)throws Exception{
        Map<String,String> a=new HashMap<>();for(int i=0;i+1<argv.length;i+=2)a.put(argv[i].replaceFirst("^--",""),argv[i+1]);
        port=Integer.parseInt(a.get("rpc"));
        String reqId=a.get("request"),reqAddr=a.get("reqaddr"),anchorAddr=a.get("anchor"),vault=a.get("vault"),r2t1=a.get("r2t1");
        // The generation this council pays for (its anchor tag): R2T2 by default, R2T3 with --gen 0x52325433.
        final String gen=a.getOrDefault("gen",R2Receiver.GENERATION_R2T2);
        // R2T4 (DEPOSIT_PROOF_DESIGN.md) deposits through the gate go into the R2T3 vault: that council pays both.
        final Set<String> gens=new HashSet<>();gens.add(gen.toLowerCase(java.util.Locale.ROOT));
        if(R2Anchors.eq(gen,R2Receiver.GENERATION_R2T3))gens.add(R2Receiver.GENERATION_R2T4.toLowerCase(java.util.Locale.ROOT));
        Set<String> exited=new HashSet<>();if(a.get("exited")!=null)for(String x:a.get("exited").split(","))if(!x.isEmpty())exited.add(R2Anchors.norm(x));
        final String seenFile=a.get("seen");loadSeen(seenFile);
        JSONObject out=new JSONObject();out.put("request",reqId);
        try{
            JSONObject rc=coin(reqId);
            if(rc==null||Boolean.TRUE.equals(rc.get("spent"))||!R2Anchors.eq((String)rc.get("address"),reqAddr))throw R2Codec.fail("request","not an unspent coin at the exit request address");
            Map<Integer,String> s=state(rc);
            if(!R2Anchors.eq(s.get(0),"0x52325445"))throw R2Codec.fail("request","port 0 is not the request tag");
            byte[] bytes;
            if(s.containsKey(30)){
                // The package inline in ports 30 on (requests before 0.0.13.037). Above INLINE_MAX its payout would be too large
                // for any block (2026-10-16): refused with "too-large", so the coin can leave again with its package in carriers.
                ByteArrayOutputStream pkg=new ByteArrayOutputStream();
                for(int p=30;p<30+R2Exit.PORTS&&s.containsKey(p);p++)pkg.write(R2Codec.unhex(s.get(p).trim()));
                bytes=pkg.toByteArray();
                if(bytes.length>R2Exit.INLINE_MAX)throw R2Codec.fail("too-large","package "+bytes.length+" bytes inline: its payout would not fit a block; post it again in carriers");
            }else{
                // Package carriers (R2Exit): parts posted to the package address, matched by the hashes in port 18.
                if(s.get(18)==null||s.get(10)==null)throw R2Codec.fail("request","no package: neither ports 30 on nor port 18");
                List<byte[]> parts=new ArrayList<>();
                JSONArray cs=(JSONArray)rpc("coins address:"+R2Exit.PACKAGE_ADDRESS).get("response");
                for(Object o:cs){JSONObject c=(JSONObject)o;Map<Integer,String> cp=state(c);
                    if(!R2Anchors.eq(cp.get(0),R2Exit.PACKAGE_TAG)||!R2Anchors.eq(cp.get(1),s.get(10)))continue;
                    StringBuilder h=new StringBuilder();for(int p=3;p<3+R2Exit.CARRIER_PORTS&&cp.containsKey(p);p++)h.append(cp.get(p).trim().replaceFirst("^0[xX]",""));
                    try{parts.add(R2Codec.unhex(h.toString()));}catch(IllegalArgumentException ignored){}}
                bytes=R2Exit.assemble(R2Codec.unhex(s.get(18).trim()),parts,R2Codec.unhex(s.get(10).trim()));
                out.put("carriers",parts.size());
            }
            if(!R2Anchors.eq(s.get(10),R2Codec.hex(R2Codec.sha256(bytes))))throw R2Codec.fail("request","port 10 is not the package hash");
            long now=tip();
            Set<String> older=new HashSet<>();                       // anchors that are not R2T2 deposits
            R2Receiver.Chain chain=(id,proof)->{
                try{
                    String cid="0x"+R2Codec.hex(id);JSONObject c=coin(cid);
                    // R2T4: a marker older than this node's window comes with the payer's fresh proof; imported and tracked.
                    if(c==null&&proof!=null&&proof.length>0){
                        try{rpc("coinimport data:0x"+R2Codec.hex(proof)+" track:true");}catch(Exception ignored){}
                        c=coin(cid);
                    }
                    if(c==null)return R2Receiver.AnchorView.missing();
                    Map<Integer,String> st=state(c);Boolean proven=null;
                    String tag=st.get(0)==null?"":st.get(0).trim().toLowerCase(java.util.Locale.ROOT);
                    if(!gens.contains(tag))older.add(cid);
                    if(R2Anchors.eq(st.get(0),gen)){
                        proven=false;
                        for(R2Anchors.Tx t:deposits(anchorAddr))if(t.creates(cid))proven=R2Anchors.depositProven(cid,t,anchorAddr,vault,st.get(2),st.get(3));
                    }
                    return new R2Receiver.AnchorView(true,Boolean.TRUE.equals(c.get("spent")),(String)c.get("address"),R2Codec.unhex((String)c.get("tokenid")),
                            String.valueOf(c.get("tokenamount")),st,now-Long.parseLong(String.valueOf(c.get("created"))),proven);
                }catch(Exception e){throw new IllegalStateException(e);}
            };
            Set<String> revoked=R2Status.parse(new String(Files.readAllBytes(Paths.get(a.get("status"))),StandardCharsets.UTF_8));
            R2Attestation att=R2Attestation.production(revoked);
            Map<String,String> anchorsByGen=new HashMap<>();for(String g:gens)anchorsByGen.put(g,anchorAddr);
            R2Receiver council=new R2Receiver(att::verifyKey,chain,r2t1,anchorsByGen,3).deposits(R2Deposits.mainnet());
            R2Receiver.Ledger ledger=new R2Receiver.Ledger(){
                public R2Request outstanding(byte[] kh){return null;}
                public boolean credited(byte[] kh){return false;}
                public byte[] seenSpender(byte[] p){String b=seenBody.get(R2Codec.hex(p));return b==null?null:R2Codec.unhex(b);}
                public byte[] seenWire(byte[] h){String w=seenWire.get(R2Codec.hex(h));return w==null?null:R2Codec.unhex(w);}
                public boolean exited(byte[] id){return exited.contains(R2Codec.hex(id));}
            };
            // A refund (failed payments, 2026-10-16): the receiver's signed refusal and the payer's bundle. Same request
            // contract and ports: 11 the refunded coin, 12 its amount, 13 its token, 14 the payout the refusal names.
            if(R2Refusal.isPackage(bytes)){
                R2Receiver.RefundResult f=council.checkRefund(bytes,ledger);
                out.put("packageBytes",bytes.length);out.put("kind","refund");
                if(f.coinId!=null){out.put("coinId","0x"+R2Codec.hex(f.coinId));out.put("amount",R2Codec.decimal(f.amount));
                    out.put("token","0x"+R2Codec.hex(f.token));}
                if(f.refusal!=null){out.put("payout","0x"+R2Codec.hex(f.refusal.payout));out.put("refusedRequest","0x"+R2Codec.hex(f.refusal.keyHash));}
                if(!f.accepted)throw R2Codec.fail(f.code,f.detail);
                if(!older.isEmpty())throw R2Codec.fail("anchor-generation","the coin rests on a deposit outside this vault's generation: "+older.iterator().next());
                if(!R2Anchors.eq(s.get(11),R2Codec.hex(f.coinId)))throw R2Codec.fail("request","port 11 is not the refunded coin");
                if(R2Codec.atoms(s.get(12).trim())!=f.amount)throw R2Codec.fail("request","port 12 is not the refunded amount");
                if(!R2Anchors.eq(s.get(13),R2Codec.hex(f.token)))throw R2Codec.fail("request","port 13 is not the refunded token");
                if(!R2Anchors.eq(s.get(14),R2Codec.hex(f.refusal.payout)))throw R2Codec.fail("request","port 14 is not the payout the refusal names");
                out.put("verdict","approve");out.put("code","accepted");out.put("depth",f.depth);
                recordSeen(seenFile,R2Refusal.unpack(bytes).bundle);
                System.out.println(out.toJSONString());
                return;
            }
            R2Receiver.ExitResult r=council.checkExit(bytes,ledger);
            out.put("packageBytes",bytes.length);
            if(r.line!=null){out.put("coinId","0x"+R2Codec.hex(r.line.coinId));out.put("amount",R2Codec.decimal(r.line.amount));
                out.put("token","0x"+R2Codec.hex(r.line.token));out.put("payout","0x"+R2Codec.hex(r.line.payout));}
            if(!r.accepted)throw R2Codec.fail(r.code,r.detail);
            // The R2T2 vault pays only for money deposited into it: a coin resting on an R2T1 deposit is backed by the
            // R2T1 vault, which has no exit.
            if(!older.isEmpty())throw R2Codec.fail("anchor-generation","the coin rests on a deposit outside this vault's generation: "+older.iterator().next());
            // The request's ports must say exactly what the coin's own key signed.
            if(!R2Anchors.eq(s.get(11),R2Codec.hex(r.line.coinId)))throw R2Codec.fail("request","port 11 is not the exited coin");
            if(R2Codec.atoms(s.get(12).trim())!=r.line.amount)throw R2Codec.fail("request","port 12 is not the signed amount");
            if(!R2Anchors.eq(s.get(13),R2Codec.hex(r.line.token)))throw R2Codec.fail("request","port 13 is not the signed token");
            if(!R2Anchors.eq(s.get(14),R2Codec.hex(r.line.payout)))throw R2Codec.fail("request","port 14 is not the signed payout address");
            // No limit per payout address (founder 2026-10-13): a new address costs nothing, so it stopped no one, and a
            // rejection loses an honest withdrawal for good. The drain cap belongs on the fallback path, in the contract.
            out.put("verdict","approve");out.put("code","accepted");out.put("depth",r.depth);
            recordSeen(seenFile,R2Exit.unpack(bytes).bundle);
        }catch(R2Codec.R2Exception e){out.put("verdict","reject");out.put("code",e.code);out.put("detail",e.getMessage());}
        System.out.println(out.toJSONString());
    }
}
