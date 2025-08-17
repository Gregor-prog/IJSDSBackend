const verify_payment = async (reference,amount) => {
    try {
        const secretKey = process.env.PAYSTACK_SECRET_KEY
        const sendReference = await fetch(`https://api.paystack.co/transaction/verify/${reference}`,{
            method:"GET",
            headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${secretKey}`}
        })
        const {status,message,data} = await sendReference.json()
        if(!status && !data.status == 'success') throw 'payment not verified, please try again later'
        if(data.amount != amount) throw 'amount paid is not the amount required,please contact support for a refund'
        return {status,dataStatus:data.status,amount}

    } catch (error) {
        if(error) throw error
        console.log(error)
    }
}

export default verify_payment