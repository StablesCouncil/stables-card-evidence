package org.stablescouncil.stables.route2;

import org.stablescouncil.stables.route2.R2Codec.In;
import org.stablescouncil.stables.route2.R2Codec.Out;
import org.stablescouncil.stables.route2.R2Codec.R2Exception;

/** Receiver to payer (trace-design.md 13.7): 127 bytes, small enough for a QR code. Amount 0: any amount, the payer chooses. */
public final class R2Request {
    public final byte[] token,recvPub,nonce;
    public final long amount;
    public R2Request(byte[] token,long amount,byte[] recvPub,byte[] nonce)throws R2Exception{
        if(token.length!=32||R2Hop.isNative(token)||amount<0||nonce.length!=16)throw R2Codec.fail("request","shape");
        R2Codec.p256(recvPub);
        this.token=token.clone();this.amount=amount;this.recvPub=recvPub.clone();this.nonce=nonce.clone();
    }
    public byte[] encode(){return new Out().ascii("STR2Q").u8(R2Codec.VERSION).raw(token).u64(amount).raw(recvPub).raw(nonce).bytes();}
    public static R2Request parse(byte[] b)throws R2Exception{
        In in=new In(b);in.magic("STR2Q");R2Request r=new R2Request(in.raw(32),in.u64(),in.raw(65),in.raw(16));in.end();return r;
    }
    public byte[] keyHash(){return R2Codec.keyHash(recvPub);}
    public boolean openAmount(){return amount==0;}

    /** Optional acknowledgement, receiver to payer. */
    public static byte[] ack(byte[] receivedCoinId){return new Out().ascii("STR2K").u8(R2Codec.VERSION).raw(receivedCoinId).bytes();}
    public static byte[] parseAck(byte[] b)throws R2Exception{In in=new In(b);in.magic("STR2K");byte[] id=in.raw(32);in.end();return id;}
}
