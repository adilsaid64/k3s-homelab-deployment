# Homelab setup :) 

IaC repo for my homelab usinng Proxmox and K3s. Iac in pulumi/sst


## Connect to your Cluster

Get your kubeconfig file from the master node and copy it to your local machine. Run the following command, replacing `<Your Master IP>` with the actual IP address of your master node. You can get this IP from Proxmox or SST outputs.

```bash
 scp ubuntu@<Your Master IP>:/etc/rancher/k3s/k3s.yaml ~/.kube/config           
```

Then update your kubeconfig file to point to the correct IP address of your master node. Open the `~/.kube/config` file in a text editor and replace the server URL with the IP address of your master node. It should look something like this:

```yaml
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ...
    server: https://<Your Master IP>:6443
  name: default
```

Save the file and verify
```bash
kubectl get nodes
```

You should see your nodes listed.