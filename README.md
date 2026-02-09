# Homelab setup :)

IaC repo for my homelab usinng Proxmox and K3s. Iac in pulumi/sst

## Deploy Infra

To deploy the infrastructure, run the following command in the root directory of the repo:

Ensure to first configure your .env file. Reference the `template.env`.

Install dependencies. Node version `18.20.8` and Pnpm version `10.13.1`.

```bash
pnpm i
```

Deploy stack

```bash
pnpm sst deploy --stage dev
```

To verify, you can login into the UI proxmox as root or you can login with the `admin-dev` (`admin-<stage>`) user created as part of the IaC to scope your view to the specific stage pool on Proxmox.

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

You should see your nodes listed. You can list your contexts with the following command:

```bash
kubectl config get-contexts
```

And you can rename your context from default to something meaningful like dev/prod, or the name of your stack with the following command:

```
kubectl config rename-context default dev
```

## Destroy Infra

To destroy all resources including, VMs, Users, Pools, and Files created by the stack, run:

```bash
pnpm sst remove --stage dev
```
