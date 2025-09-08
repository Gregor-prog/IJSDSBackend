const verify_payment = async (reference,amount) => {
    try {
        console.log("this is working")
        const secretKey = process.env.PAYSTACK_SECRET_KEY_LIVE 
        const sendReference = await fetch(`https://api.paystack.co/transaction/verify/${reference}`,{
            method:"GET",
            headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${secretKey}`}
        })
        const {status,message,data} = await sendReference.json()
        if(!status && !data.status == 'success') throw 'payment not verified, please try again later'
        if(data.amount != amount) throw 'amount paid is not the amount required,please contact support for a refund'
        console.log(status,dataStatus)
        return {status,dataStatus:data.status,amount}
    } catch (error) {
        console.log(error)
        if(error) throw error
    }
}

export default verify_payment