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
 *        --anchor 0x.. --vault 0x.. --r2t1 0x.. --status attestation-status.json [--exited a,b] [--limit 100] [--paid 0]
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

    public static void main(String[] argv)throws Exception{
        Map<String,String> a=new HashMap<>();for(int i=0;i+1<argv.length;i+=2)a.put(argv[i].replaceFirst("^--",""),argv[i+1]);
        port=Integer.parseInt(a.get("rpc"));
        String reqId=a.get("request"),reqAddr=a.get("reqaddr"),anchorAddr=a.get("anchor"),vault=a.get("vault"),r2t1=a.get("r2t1");
        // The generation this council pays for (its anchor tag): R2T2 by default, R2T3 with --gen 0x52325433.
        final String gen=a.getOrDefault("gen",R2Receiver.GENERATION_R2T2);
        Set<String> exited=new HashSet<>();if(a.get("exited")!=null)for(String x:a.get("exited").split(","))if(!x.isEmpty())exited.add(R2Anchors.norm(x));
        JSONObject out=new JSONObject();out.put("request",reqId);
        try{
            JSONObject rc=coin(reqId);
            if(rc==null||Boolean.TRUE.equals(rc.get("spent"))||!R2Anchors.eq((String)rc.get("address"),reqAddr))throw R2Codec.fail("request","not an unspent coin at the exit request address");
            Map<Integer,String> s=state(rc);
            if(!R2Anchors.eq(s.get(0),"0x52325445"))throw R2Codec.fail("request","port 0 is not the request tag");
            ByteArrayOutputStream pkg=new ByteArrayOutputStream();
            for(int p=30;p<30+R2Exit.PORTS&&s.containsKey(p);p++)pkg.write(R2Codec.unhex(s.get(p).trim()));
            byte[] bytes=pkg.toByteArray();
            if(!R2Anchors.eq(s.get(10),R2Codec.hex(R2Codec.sha256(bytes))))throw R2Codec.fail("request","port 10 is not the package hash");
            long now=tip();
            Set<String> older=new HashSet<>();                       // anchors that are not R2T2 deposits
            R2Receiver.Chain chain=(id,proof)->{
                try{
                    String cid="0x"+R2Codec.hex(id);JSONObject c=coin(cid);
                    if(c==null)return R2Receiver.AnchorView.missing();
                    Map<Integer,String> st=state(c);Boolean proven=null;
                    if(!R2Anchors.eq(st.get(0),gen))older.add(cid);
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
            R2Receiver council=new R2Receiver(att::verifyKey,chain,r2t1,java.util.Collections.singletonMap(gen,anchorAddr),3);
            R2Receiver.Ledger ledger=new R2Receiver.Ledger(){
                public R2Request outstanding(byte[] kh){return null;}
                public boolean credited(byte[] kh){return false;}
                public byte[] seenSpender(byte[] p){return null;}
                public byte[] seenWire(byte[] h){return null;}
                public boolean exited(byte[] id){return exited.contains(R2Codec.hex(id));}
            };
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
            long limit=R2Codec.atoms(a.getOrDefault("limit","100")),paid=a.containsKey("paid")&&!a.get("paid").equals("0")?R2Codec.atoms(a.get("paid")):0;
            if(paid+r.line.amount>limit)throw R2Codec.fail("limit","over the weekly exit limit of this payout address");
            out.put("verdict","approve");out.put("code","accepted");out.put("depth",r.depth);
        }catch(R2Codec.R2Exception e){out.put("verdict","reject");out.put("code",e.code);out.put("detail",e.getMessage());}
        System.out.println(out.toJSONString());
    }
}
