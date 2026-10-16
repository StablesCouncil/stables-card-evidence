package org.stablescouncil.stables.route2;

import java.util.Arrays;
import org.stablescouncil.stables.route2.R2Codec.In;
import org.stablescouncil.stables.route2.R2Codec.Out;
import org.stablescouncil.stables.route2.R2Codec.R2Exception;

/**
 * The exit line and package (trace-design.md 13.11): a coin asks to leave the card for a Savings address. Signed once by
 * the coin's own key, which the hardware then destroys, so a coin already paid away can never produce one.
 */
public final class R2Exit {
    public static final int BODY_SIZE=126;
    public final byte[] coinId,token,payout,nonce,body;public final long amount;
    private byte[] signature;

    public R2Exit(byte[] coinId,byte[] token,long amount,byte[] payout,byte[] nonce)throws R2Exception{
        if(coinId.length!=32||token.length!=32||payout.length!=32||nonce.length!=16)throw R2Codec.fail("exit","shape");
        if(R2Hop.isNative(token))throw R2Codec.fail("exit","native Minima is never a coin token");
        if(amount<=0)throw R2Codec.fail("exit","amount");
        this.coinId=coinId.clone();this.token=token.clone();this.amount=amount;this.payout=payout.clone();this.nonce=nonce.clone();
        body=new Out().ascii("STR2E").u8(R2Codec.VERSION).raw(coinId).raw(token).u64(amount).raw(payout).raw(nonce).bytes();
    }
    public static R2Exit parseBody(byte[] body)throws R2Exception{
        In in=new In(body);in.magic("STR2E");
        R2Exit e=new R2Exit(in.raw(32),in.raw(32),in.u64(),in.raw(32),in.raw(16));in.end();
        if(!Arrays.equals(e.body,body))throw R2Codec.fail("exit","non-canonical body");
        return e;
    }
    public byte[] bodyHash(){return R2Codec.sha256(body);}
    public byte[] signature(){return signature==null?null:signature.clone();}
    public R2Exit sign(byte[] der)throws R2Exception{
        if(der==null||der.length<8||der.length>72)throw R2Codec.fail("exit","signature size");
        signature=der.clone();return this;
    }
    public byte[] wire()throws R2Exception{
        if(signature==null)throw R2Codec.fail("exit","unsigned exit line");
        return new Out().var16(body).u8(signature.length).raw(signature).bytes();
    }
    public static R2Exit fromWire(byte[] wire)throws R2Exception{
        In in=new In(wire);R2Exit e=parseBody(in.var16(BODY_SIZE));e.sign(in.raw(in.u8()));in.end();return e;
    }

    /** "STR2P" | ver | exitWire (var16) | bundle (the coin's full bundle, every chain carried) to the end. */
    public static byte[] pack(R2Exit line,byte[] bundle)throws R2Exception{
        byte[] p=new Out().ascii("STR2P").u8(R2Codec.VERSION).var16(line.wire()).raw(bundle).bytes();
        if(p.length>MAX_PACKAGE)throw R2Codec.fail("limit","exit package over "+MAX_PACKAGE+" bytes");
        return p;
    }
    /** Request ports 30 to 39 carry the package, 4,000 bytes each at most (COUNCIL_ATTESTATION_DESIGN 6c.2). */
    public static final int PORT_CHUNK=4000,PORTS=10,MAX_PACKAGE=PORT_CHUNK*PORTS;
    public static final class Package { public final R2Exit line;public final byte[] bundle,hash;
        Package(R2Exit l,byte[] b,byte[] h){line=l;bundle=b;hash=h;} }
    public static Package unpack(byte[] p)throws R2Exception{
        if(p.length>MAX_PACKAGE)throw R2Codec.fail("limit","exit package size");
        In in=new In(p);in.magic("STR2P");R2Exit line=fromWire(in.var16(512));
        byte[] bundle=Arrays.copyOfRange(p,p.length-remaining(p,line),p.length);
        return new Package(line,bundle,R2Codec.sha256(p));
    }
    private static int remaining(byte[] p,R2Exit line)throws R2Exception{
        int head=5+1+2+line.wire().length;if(head>p.length)throw R2Codec.fail("parse","truncated");return p.length-head;
    }
    /* PACKAGE CARRIERS (founder 2026-10-16: "we have to go for the permanent solution, the one we will implement in
       production"). A payout spends the request coin, and that coin carried the whole package in its state, stored at
       about twice its size: a 31,124-byte refund package made a 70,262-byte payout no block takes, and its 20 Winiwa could
       not be paid by the Council or by the fallback. The package now travels in carrier transactions of its own: one atom
       each to PACKAGE_ADDRESS (script RETURN FALSE: nothing ever spends them), state port 0 the tag, 1 the package hash,
       2 the part's index, 3 to 8 its bytes (4,000 each). The request keeps its ports and names each part's SHA-256 in port
       18, so a checker rebuilds the package from the carriers whose bytes match, whatever else anyone posts there. The
       request contract never reads ports 30 on, so nothing on chain changes; a request with the package inline still
       checks, and one too large to be paid is rejected (INLINE_MAX). */
    public static final String PACKAGE_ADDRESS="0xABA005476D2B3CD7F251B9783E64C124C9670BB358695F04D91B2057BB64CB49";
    public static final String PACKAGE_SCRIPT="RETURN FALSE";
    public static final String PACKAGE_TAG="0x5232504B";                     // "R2PK"
    public static final int CARRIER_PORTS=6,CARRIER_BYTES=PORT_CHUNK*CARRIER_PORTS,MAX_CARRIERS=4;
    /** The largest package a request may carry inline and still be paid out: 25,500 bytes made a 57,653-byte payout that
     *  was mined, 31,124 bytes a 70,262-byte one that never was (2026-10-16). */
    public static final int INLINE_MAX=25500;
    /** The package cut into carrier parts of at most CARRIER_BYTES. */
    public static java.util.List<byte[]> carrierParts(byte[] p)throws R2Exception{
        if(p.length>MAX_PACKAGE)throw R2Codec.fail("limit","package size");
        java.util.List<byte[]> l=new java.util.ArrayList<>();
        for(int i=0;i<p.length;i+=CARRIER_BYTES)l.add(Arrays.copyOfRange(p,i,Math.min(p.length,i+CARRIER_BYTES)));
        if(l.size()>MAX_CARRIERS)throw R2Codec.fail("limit","package needs more than "+MAX_CARRIERS+" carriers");
        return l;
    }
    /** Port 18 of a request: the SHA-256 of each part, in order (32 bytes each). */
    public static byte[] partHashes(java.util.List<byte[]> parts){
        byte[] h=new byte[32*parts.size()];
        for(int i=0;i<parts.size();i++)System.arraycopy(R2Codec.sha256(parts.get(i)),0,h,32*i,32);
        return h;
    }
    /** One part as carrier state ports 3 to 8 (hex, no prefix). */
    public static String[] partPorts(byte[] part){
        int n=(part.length+PORT_CHUNK-1)/PORT_CHUNK;String[] c=new String[n];
        for(int i=0;i<n;i++)c[i]=R2Codec.hex(Arrays.copyOfRange(part,i*PORT_CHUNK,Math.min(part.length,(i+1)*PORT_CHUNK)));
        return c;
    }
    /**
     * The package rebuilt from the parts posted for it: for each hash in port 18, a candidate whose SHA-256 matches. Any
     * number of other candidates (a copy, junk posted by anyone) is ignored. Throws code "package-missing" when a part is not
     * seen (yet), and checks the whole against the request's package hash (port 10).
     */
    public static byte[] assemble(byte[] partHashes,java.util.Collection<byte[]> candidates,byte[] packageHash)throws R2Exception{
        if(partHashes==null||partHashes.length==0||partHashes.length%32!=0||partHashes.length/32>MAX_CARRIERS)throw R2Codec.fail("request","port 18 does not name the package parts");
        java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();
        for(int i=0;i<partHashes.length/32;i++){
            byte[] want=Arrays.copyOfRange(partHashes,32*i,32*i+32),found=null;
            for(byte[] c:candidates)if(c!=null&&c.length<=CARRIER_BYTES&&Arrays.equals(R2Codec.sha256(c),want)){found=c;break;}
            if(found==null)throw R2Codec.fail("package-missing","part "+(i+1)+" of "+partHashes.length/32+" not seen");
            out.write(found,0,found.length);
        }
        byte[] p=out.toByteArray();
        if(packageHash==null||!Arrays.equals(R2Codec.sha256(p),packageHash))throw R2Codec.fail("request","the parts do not make the package named in port 10");
        return p;
    }

    /** The package as request state chunks (hex, no prefix), port 30 first. */
    public static String[] chunks(byte[] p)throws R2Exception{
        if(p.length>MAX_PACKAGE)throw R2Codec.fail("limit","exit package size");
        int n=(p.length+PORT_CHUNK-1)/PORT_CHUNK;String[] c=new String[n];
        for(int i=0;i<n;i++)c[i]=R2Codec.hex(Arrays.copyOfRange(p,i*PORT_CHUNK,Math.min(p.length,(i+1)*PORT_CHUNK)));
        return c;
    }
}
