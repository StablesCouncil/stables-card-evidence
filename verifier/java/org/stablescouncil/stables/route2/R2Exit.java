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
    /** The package as request state chunks (hex, no prefix), port 30 first. */
    public static String[] chunks(byte[] p)throws R2Exception{
        if(p.length>MAX_PACKAGE)throw R2Codec.fail("limit","exit package size");
        int n=(p.length+PORT_CHUNK-1)/PORT_CHUNK;String[] c=new String[n];
        for(int i=0;i<n;i++)c[i]=R2Codec.hex(Arrays.copyOfRange(p,i*PORT_CHUNK,Math.min(p.length,(i+1)*PORT_CHUNK)));
        return c;
    }
}
